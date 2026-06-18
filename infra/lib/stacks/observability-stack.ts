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

    Tags.of(this).add("skout:environment", config.name);
  }
}
