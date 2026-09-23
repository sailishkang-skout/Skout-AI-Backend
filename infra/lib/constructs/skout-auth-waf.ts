import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export interface SkoutAuthWafProps {
  readonly name: string;
  /** ALB the web ACL protects. Every front-door mode (none / apigateway / cloudfront) ends here. */
  readonly loadBalancerArn: string;
  /**
   * True when a front door (API Gateway / CloudFront) sits in front of the ALB. The ALB then sees
   * the front door's IPs, not the client's, so limits are keyed on X-Forwarded-For instead.
   */
  readonly behindFrontDoor: boolean;
}

interface AuthRateRule {
  readonly id: string;
  readonly limit: number;
  /** Lowercase substrings; a request matches if its URI path contains any of them. */
  readonly pathContains: string[];
}

/**
 * Credential-stuffing / brute-force protection for own-auth (AUTH-ADI-11). Stricter limits for
 * the endpoints an attacker actually hammers, plus a looser catch-all for the rest of /auth/.
 * Limits are per client IP per 5 minutes. Nothing matches until the own-auth routes exist.
 *
 * Known limit: behind a front door the client IP comes from X-Forwarded-For, whose first entry
 * a client can set itself, so a determined attacker can rotate it to evade the per-IP limit.
 * This is a coarse outer layer; the per-IP and per-account limits inside the API (AUTH-BE-14)
 * are the real control.
 */
export class SkoutAuthWaf extends Construct {
  constructor(scope: Construct, id: string, props: SkoutAuthWafProps) {
    super(scope, id);

    const rules: AuthRateRule[] = [
      { id: "Login", limit: 20, pathContains: ["/auth/login", "/auth/google", "/auth/microsoft"] },
      { id: "Signup", limit: 10, pathContains: ["/auth/signup"] },
      {
        id: "RecoveryAndOtp",
        limit: 10,
        pathContains: ["/auth/password", "/auth/otp", "/auth/verify-email"],
      },
      // Catch-all for anything else under /auth/ (refresh, logout, me, discover, step-up).
      { id: "AuthGeneral", limit: 300, pathContains: ["/api/v1/auth/", "/app/api/auth/"] },
    ];

    const pathMatch = (needle: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        searchString: needle,
        fieldToMatch: { uriPath: {} },
        textTransformations: [{ priority: 0, type: "LOWERCASE" }],
        positionalConstraint: "CONTAINS",
      },
    });

    const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });

    const acl = new wafv2.CfnWebACL(this, "Acl", {
      name: `${props.name}-auth-rate-limits`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${props.name}-auth-waf`),
      rules: rules.map((rule, index) => ({
        name: `${props.name}-auth-${rule.id}`,
        priority: index,
        action: { block: {} },
        visibilityConfig: visibility(`${props.name}-auth-${rule.id}`),
        statement: {
          rateBasedStatement: {
            limit: rule.limit,
            evaluationWindowSec: 300,
            ...(props.behindFrontDoor
              ? {
                  aggregateKeyType: "FORWARDED_IP",
                  forwardedIpConfig: { headerName: "X-Forwarded-For", fallbackBehavior: "MATCH" },
                }
              : { aggregateKeyType: "IP" }),
            scopeDownStatement:
              rule.pathContains.length === 1
                ? pathMatch(rule.pathContains[0]!)
                : { orStatement: { statements: rule.pathContains.map(pathMatch) } },
          },
        },
      })),
    });

    new wafv2.CfnWebACLAssociation(this, "AlbAssociation", {
      resourceArn: props.loadBalancerArn,
      webAclArn: acl.attrArn,
    });
  }
}
