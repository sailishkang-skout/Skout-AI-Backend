export type SkoutEnvironment = "local" | "dev" | "uat" | "prod";

export interface EnvironmentConfig {
  readonly name: SkoutEnvironment;
  readonly stackPrefix: string;
  readonly account?: string;
  readonly region: string;
  readonly domainName?: string;
  readonly apiSubdomain?: string;
  readonly webSubdomain?: string;
  readonly deployToAws: boolean;
  readonly vpc: {
    readonly maxAzs: number;
    readonly natGateways: number;
  };
  readonly database: {
    readonly instanceClass: string;
    readonly allocatedStorageGb: number;
    readonly multiAz: boolean;
    readonly backupRetentionDays: number;
    readonly deletionProtection: boolean;
  };
  readonly redis: {
    readonly nodeType: string;
    readonly numCacheNodes: number;
  };
  readonly ecs: {
    readonly apiCpu: number;
    readonly apiMemoryMiB: number;
    readonly apiDesiredCount: number;
    readonly aiCpu: number;
    readonly aiMemoryMiB: number;
    readonly aiDesiredCount: number;
    readonly webCpu: number;
    readonly webMemoryMiB: number;
    readonly webDesiredCount: number;
  };
  readonly s3: {
    readonly exportsRetentionDays: number;
    readonly versioning: boolean;
  };
  readonly github?: {
    readonly org: string;
    readonly backendRepo: string;
    readonly frontendRepo: string;
  };
  readonly alertEmail?: string;
  /** Import pre-existing SkoutDev/openai secret instead of creating (dev only). */
  readonly importOpenAiSecret?: boolean;
}

const baseGithub = {
  org: process.env.GITHUB_ORG ?? "sailishkang-skout",
  backendRepo: process.env.GITHUB_BACKEND_REPO ?? "Skout-AI-Backend",
  frontendRepo: process.env.GITHUB_FRONTEND_REPO ?? "Skout-Ai-Frontend",
};

export const ENVIRONMENTS: Record<SkoutEnvironment, EnvironmentConfig> = {
  local: {
    name: "local",
    stackPrefix: "SkoutLocal",
    region: "us-east-1",
    deployToAws: false,
    vpc: { maxAzs: 1, natGateways: 0 },
    database: {
      instanceClass: "t4g.micro",
      allocatedStorageGb: 20,
      multiAz: false,
      backupRetentionDays: 0,
      deletionProtection: false,
    },
    redis: { nodeType: "cache.t4g.micro", numCacheNodes: 1 },
    ecs: {
      apiCpu: 256,
      apiMemoryMiB: 512,
      apiDesiredCount: 1,
      aiCpu: 256,
      aiMemoryMiB: 512,
      aiDesiredCount: 1,
      webCpu: 256,
      webMemoryMiB: 512,
      webDesiredCount: 1,
    },
    s3: { exportsRetentionDays: 7, versioning: false },
    github: baseGithub,
  },
  dev: {
    name: "dev",
    stackPrefix: "SkoutDev",
    region: process.env.AWS_REGION ?? "us-east-1",
    domainName: process.env.DEV_DOMAIN_NAME,
    apiSubdomain: "api-dev",
    webSubdomain: "app-dev",
    deployToAws: true,
    vpc: { maxAzs: 2, natGateways: 1 },
    database: {
      instanceClass: "t4g.micro",
      allocatedStorageGb: 20,
      multiAz: false,
      backupRetentionDays: 3,
      deletionProtection: false,
    },
    redis: { nodeType: "cache.t4g.micro", numCacheNodes: 1 },
    ecs: {
      apiCpu: 256,
      apiMemoryMiB: 1024,
      apiDesiredCount: 1,
      aiCpu: 256,
      aiMemoryMiB: 512,
      aiDesiredCount: 1,
      webCpu: 256,
      webMemoryMiB: 512,
      webDesiredCount: 1,
    },
    s3: { exportsRetentionDays: 30, versioning: true },
    github: baseGithub,
    alertEmail: process.env.ALERT_EMAIL,
    importOpenAiSecret: false,
  },
  uat: {
    name: "uat",
    stackPrefix: "SkoutUat",
    region: process.env.AWS_REGION ?? "us-east-1",
    domainName: process.env.UAT_DOMAIN_NAME,
    apiSubdomain: "api-uat",
    webSubdomain: "app-uat",
    deployToAws: true,
    vpc: { maxAzs: 2, natGateways: 1 },
    database: {
      instanceClass: "t4g.micro",
      allocatedStorageGb: 20,
      multiAz: false,
      backupRetentionDays: 7,
      deletionProtection: false,
    },
    redis: { nodeType: "cache.t4g.micro", numCacheNodes: 1 },
    ecs: {
      apiCpu: 256,
      apiMemoryMiB: 512,
      apiDesiredCount: 1,
      aiCpu: 256,
      aiMemoryMiB: 512,
      aiDesiredCount: 1,
      webCpu: 256,
      webMemoryMiB: 512,
      webDesiredCount: 1,
    },
    s3: { exportsRetentionDays: 60, versioning: true },
    github: baseGithub,
    alertEmail: process.env.ALERT_EMAIL,
  },
  prod: {
    name: "prod",
    stackPrefix: "SkoutProd",
    region: process.env.AWS_REGION ?? "us-east-1",
    domainName: process.env.PROD_DOMAIN_NAME,
    apiSubdomain: "api",
    webSubdomain: "app",
    deployToAws: true,
    vpc: { maxAzs: 2, natGateways: 2 },
    database: {
      instanceClass: "t4g.small",
      allocatedStorageGb: 50,
      multiAz: true,
      backupRetentionDays: 14,
      deletionProtection: true,
    },
    redis: { nodeType: "cache.t4g.small", numCacheNodes: 1 },
    ecs: {
      apiCpu: 512,
      apiMemoryMiB: 1024,
      apiDesiredCount: 2,
      aiCpu: 512,
      aiMemoryMiB: 1024,
      aiDesiredCount: 2,
      webCpu: 512,
      webMemoryMiB: 1024,
      webDesiredCount: 2,
    },
    s3: { exportsRetentionDays: 90, versioning: true },
    github: baseGithub,
    alertEmail: process.env.ALERT_EMAIL,
  },
};

export function getEnvironment(name: string): EnvironmentConfig {
  const env = ENVIRONMENTS[name as SkoutEnvironment];
  if (!env) {
    throw new Error(`Unknown environment "${name}". Use: local, dev, uat, or prod.`);
  }
  return env;
}
