import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import { Duration, Stack, StackProps, Tags } from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/environments.js";

export interface ObservabilityStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly apiService: ecs.FargateService;
  readonly database: rds.DatabaseInstance;
  readonly apiLogGroupName: string;
  readonly alertEmail?: string;
  /**
   * SES sending quota per 24h, used to size the quota alarm (AUTH-ADI-10). Defaults to the
   * SES sandbox limit (200) — raise this when production access is granted, or the alarm will
   * fire constantly on normal volume.
   */
  readonly sesDailySendQuota?: number;
}

export class ObservabilityStack extends Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config, loadBalancer, apiService, database, apiLogGroupName } = props;

    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `${config.stackPrefix}-alarms`,
      displayName: `Skout ${config.name} infrastructure alarms`,
    });

    if (props.alertEmail) {
      alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(props.alertEmail));
    }

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    const alb5xx = new cloudwatch.Alarm(this, "Alb5xxAlarm", {
      alarmName: `${config.stackPrefix}-alb-5xx`,
      metric: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alb5xx.addAlarmAction(alarmAction);

    const apiCpu = new cloudwatch.Alarm(this, "ApiCpuAlarm", {
      alarmName: `${config.stackPrefix}-api-cpu-high`,
      metric: apiService.metricCpuUtilization({ period: Duration.minutes(5) }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    apiCpu.addAlarmAction(alarmAction);

    const dbCpu = new cloudwatch.Alarm(this, "DbCpuAlarm", {
      alarmName: `${config.stackPrefix}-rds-cpu-high`,
      metric: database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    dbCpu.addAlarmAction(alarmAction);

    const apiLogGroup = logs.LogGroup.fromLogGroupName(this, "ApiLogGroup", apiLogGroupName);

    const apiErrorMetricFilter = new logs.MetricFilter(this, "ApiErrorLogFilter", {
      logGroup: apiLogGroup,
      filterPattern: logs.FilterPattern.literal('{ $.level = 50 }'),
      metricNamespace: `Skout/${config.name}`,
      metricName: "ApiLogErrors",
      metricValue: "1",
      defaultValue: 0,
    });

    const apiLogErrors = apiErrorMetricFilter.metric({
      statistic: "Sum",
      period: Duration.minutes(5),
    });

    const apiErrorAlarm = new cloudwatch.Alarm(this, "ApiLogErrorAlarm", {
      alarmName: `${config.stackPrefix}-api-log-errors`,
      metric: apiLogErrors,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrorAlarm.addAlarmAction(alarmAction);

    // AUTH-ADI-10 — own-auth makes email a hard dependency for login (verify / reset / OTP), so
    // a suspended or throttled SES account is a login outage. These use the account-level SES
    // reputation metrics, which AWS publishes automatically (no configuration set needed).
    // SES starts a compliance review at 5% bounces / 0.1% complaints and pauses sending at
    // 10% / 0.5%; alarm before the review threshold.
    const sesMetric = (metricName: string, statistic: string, period: Duration) =>
      new cloudwatch.Metric({ namespace: "AWS/SES", metricName, statistic, period });

    const sesBounceRate = new cloudwatch.Alarm(this, "SesBounceRateAlarm", {
      alarmName: `${config.stackPrefix}-ses-bounce-rate`,
      alarmDescription: "SES account bounce rate approaching the 5% review threshold",
      metric: sesMetric("Reputation.BounceRate", "Average", Duration.hours(1)),
      threshold: 0.04,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesBounceRate.addAlarmAction(alarmAction);

    const sesComplaintRate = new cloudwatch.Alarm(this, "SesComplaintRateAlarm", {
      alarmName: `${config.stackPrefix}-ses-complaint-rate`,
      alarmDescription: "SES account complaint rate approaching the 0.1% review threshold",
      metric: sesMetric("Reputation.ComplaintRate", "Average", Duration.hours(1)),
      threshold: 0.0008,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesComplaintRate.addAlarmAction(alarmAction);

    const sesDailySendQuota = props.sesDailySendQuota ?? 200;
    const sesQuota = new cloudwatch.Alarm(this, "SesSendQuotaAlarm", {
      alarmName: `${config.stackPrefix}-ses-send-quota`,
      alarmDescription: `SES sends in the last 24h above 80% of the ${sesDailySendQuota}/day quota`,
      metric: sesMetric("Send", "Sum", Duration.days(1)),
      threshold: sesDailySendQuota * 0.8,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesQuota.addAlarmAction(alarmAction);

    // AUTH-ADI-12 — per-issuer auth dashboards and alarms, built from AUTH-BE-20's structured
    // log metrics (packages/auth/src/auth-metrics.ts emits `metric`/`issuer`/`result` as
    // top-level JSON fields via @skout/observability's logger — same convention as
    // ApiLogErrorAlarm above, so this follows the identical MetricFilter pattern rather than
    // introducing a second metrics pipeline). Wiring status as of this ticket: auth.verify is
    // live (resolve-auth.ts); auth.refresh / auth.refresh_reuse are live (session.service.ts);
    // auth.login is NOT wired into the login route yet — the login-related metric/alarm below
    // will show no data until that's added. SES bounce/complaint/quota alarms already exist
    // above (AUTH-ADI-10) and aren't duplicated here.
    const authMetricNamespace = `Skout/${config.name}/Auth`;

    const authLogMetric = (id: string, metricName: string, pattern: string) => {
      const filter = new logs.MetricFilter(this, id, {
        logGroup: apiLogGroup,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricNamespace: authMetricNamespace,
        metricName,
        metricValue: "1",
        defaultValue: 0,
      });
      return filter.metric({ statistic: "Sum", period: Duration.minutes(5) });
    };

    // Per-issuer verify (dashboard: "auth successes/failures by issuer").
    const verifyClerkSuccess = authLogMetric(
      "AuthVerifyClerkSuccessFilter",
      "AuthVerifyClerkSuccess",
      '{ $.metric = "auth.verify" && $.issuer = "clerk" && $.result = "success" }'
    );
    const verifyClerkFailure = authLogMetric(
      "AuthVerifyClerkFailureFilter",
      "AuthVerifyClerkFailure",
      '{ $.metric = "auth.verify" && $.issuer = "clerk" && $.result = "failure" }'
    );
    const verifySkoutSuccess = authLogMetric(
      "AuthVerifySkoutSuccessFilter",
      "AuthVerifySkoutSuccess",
      '{ $.metric = "auth.verify" && $.issuer = "skout" && $.result = "success" }'
    );
    const verifySkoutFailure = authLogMetric(
      "AuthVerifySkoutFailureFilter",
      "AuthVerifySkoutFailure",
      '{ $.metric = "auth.verify" && $.issuer = "skout" && $.result = "failure" }'
    );

    // Login / refresh success rate (dashboard).
    const loginSuccess = authLogMetric(
      "AuthLoginSuccessFilter",
      "AuthLoginSuccess",
      '{ $.metric = "auth.login" && $.result = "success" }'
    );
    const loginFailure = authLogMetric(
      "AuthLoginFailureFilter",
      "AuthLoginFailure",
      '{ $.metric = "auth.login" && $.result = "failure" }'
    );
    const refreshSuccess = authLogMetric(
      "AuthRefreshSuccessFilter",
      "AuthRefreshSuccess",
      '{ $.metric = "auth.refresh" && $.result = "success" }'
    );
    const refreshFailure = authLogMetric(
      "AuthRefreshFailureFilter",
      "AuthRefreshFailure",
      '{ $.metric = "auth.refresh" && $.result = "failure" }'
    );
    const refreshReuse = authLogMetric(
      "AuthRefreshReuseFilter",
      "AuthRefreshReuse",
      '{ $.metric = "auth.refresh_reuse" }'
    );

    // 401/403 rate: the API has no per-request completion logger (checked — apps/api/src/app.ts's
    // only onSend hook normalizes response *bodies*, it never calls the logger), so there's no
    // reliable JSON field to filter on for this. Using the ALB's native 4xx metric instead — the
    // same source Alb5xxAlarm already relies on for 5xx, so at least it's honestly measuring
    // something rather than a metric filter that would silently sit near-empty. Trade-off: this
    // is every 4xx on the whole ALB (400/404/422/etc. included), not auth-path-scoped or
    // 401/403-specific — a real path/status breakdown needs ALB access logs (S3 + Athena/Logs
    // Insights), out of scope here.
    const alb4xx = loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, {
      period: Duration.minutes(5),
    });
    const authPath5xx = authLogMetric(
      "AuthPath5xxFilter",
      "AuthPath5xxCount",
      '{ $.level = 50 && $.httpPath = "/api/v1/auth*" }'
    );
    const jwksErrors = authLogMetric(
      "JwksErrorsFilter",
      "JwksErrors",
      '{ $.level = 50 && $.httpPath = "/.well-known/jwks.json" }'
    );

    // ---- Alarms ----

    const refreshReuseAlarm = new cloudwatch.Alarm(this, "AuthRefreshReuseAlarm", {
      alarmName: `${config.stackPrefix}-auth-refresh-reuse`,
      alarmDescription: "A used refresh token was presented again — possible token theft (AUTH-BE-13 reuse detection)",
      metric: refreshReuse,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    refreshReuseAlarm.addAlarmAction(alarmAction);

    const loginFailureSpikeAlarm = new cloudwatch.Alarm(this, "AuthLoginFailureSpikeAlarm", {
      alarmName: `${config.stackPrefix}-auth-login-failure-spike`,
      alarmDescription: "Login failures spiking — possible credential stuffing",
      metric: loginFailure,
      threshold: 20,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    loginFailureSpikeAlarm.addAlarmAction(alarmAction);

    const authPath5xxAlarm = new cloudwatch.Alarm(this, "AuthPath5xxAlarm", {
      alarmName: `${config.stackPrefix}-auth-path-5xx`,
      alarmDescription: "Server errors on /api/v1/auth/*",
      metric: authPath5xx,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    authPath5xxAlarm.addAlarmAction(alarmAction);

    const jwksErrorAlarm = new cloudwatch.Alarm(this, "JwksErrorAlarm", {
      alarmName: `${config.stackPrefix}-jwks-errors`,
      alarmDescription: "GET /.well-known/jwks.json is erroring — every service that verifies own-auth tokens depends on this",
      metric: jwksErrors,
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    jwksErrorAlarm.addAlarmAction(alarmAction);

    // "Clerk-issuer traffic is zero" — inert until dual-verify (AUTH-ADI-15) is live; the point
    // is to catch it at cutover (G7), not before. Missing data (zero events) IS the failure
    // condition here, unlike every alarm above, so treatMissingData is deliberately BREACHING.
    const clerkTrafficZeroAlarm = new cloudwatch.Alarm(this, "ClerkIssuerTrafficZeroAlarm", {
      alarmName: `${config.stackPrefix}-clerk-issuer-traffic-zero`,
      alarmDescription: "No Clerk-issued tokens verified in 24h — safe to disable the Clerk issuer at cutover (G7). Expect this to alarm continuously before dual-verify (AUTH-ADI-15) ships; that's expected, not actionable yet.",
      metric: new cloudwatch.MathExpression({
        expression: "clerkSuccess + clerkFailure",
        usingMetrics: { clerkSuccess: verifyClerkSuccess, clerkFailure: verifyClerkFailure },
        period: Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    clerkTrafficZeroAlarm.addAlarmAction(alarmAction);

    // ---- Dashboard ----

    new cloudwatch.Dashboard(this, "AuthDashboard", {
      dashboardName: `${config.stackPrefix}-auth`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "Token verification by issuer",
            left: [verifyClerkSuccess, verifyClerkFailure, verifySkoutSuccess, verifySkoutFailure],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: "Login / refresh success vs failure",
            left: [loginSuccess, loginFailure, refreshSuccess, refreshFailure],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "Refresh-token reuse (theft signal)",
            left: [refreshReuse],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: "4xx on the ALB (whole API, not auth-path-scoped — see comment above)",
            left: [alb4xx],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: "5xx: /api/v1/auth/* and JWKS errors",
            left: [authPath5xx, jwksErrors],
            width: 8,
          }),
        ],
        [
          new cloudwatch.AlarmStatusWidget({
            title: "Auth alarm status",
            alarms: [
              refreshReuseAlarm,
              loginFailureSpikeAlarm,
              authPath5xxAlarm,
              jwksErrorAlarm,
              clerkTrafficZeroAlarm,
            ],
            width: 24,
          }),
        ],
      ],
    });

    Tags.of(this).add("skout:environment", config.name);
  }
}
