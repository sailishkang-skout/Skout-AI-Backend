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

    Tags.of(this).add("skout:environment", config.name);
  }
}
