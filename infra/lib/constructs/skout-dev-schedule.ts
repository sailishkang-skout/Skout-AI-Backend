import * as ecs from "aws-cdk-lib/aws-ecs";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";

/**
 * Dev-only cost lever: scales a Fargate service to 0 outside business hours instead of
 * running it 24/7. Scale-down runs every day at 22:00 IST (16:30 UTC); scale-up runs
 * Mon-Fri at 11:00 IST (05:30 UTC) — so a Friday-evening scale-down persists through the
 * weekend since there's no Sat/Sun scale-up. AWS Application Auto Scaling cron is UTC-only.
 */
export function applyBusinessHoursSchedule(service: ecs.FargateService, desiredCount: number): void {
  const scalable = service.autoScaleTaskCount({ minCapacity: 0, maxCapacity: desiredCount });

  scalable.scaleOnSchedule("ScaleDownOffHours", {
    schedule: appscaling.Schedule.cron({ minute: "30", hour: "16" }),
    minCapacity: 0,
    maxCapacity: 0,
  });

  scalable.scaleOnSchedule("ScaleUpBusinessHours", {
    schedule: appscaling.Schedule.cron({ minute: "30", hour: "5", weekDay: "MON-FRI" }),
    minCapacity: desiredCount,
    maxCapacity: desiredCount,
  });
}

/** Fargate Spot for services that can tolerate interruption (non-interactive / non-prod only). */
export const SPOT_STRATEGY: ecs.CapacityProviderStrategy[] = [
  { capacityProvider: "FARGATE_SPOT", weight: 1 },
];
