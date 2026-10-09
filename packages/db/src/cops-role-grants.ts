/** Default CustomerOps role grants seeded into the existing workspace RBAC catalog. */
export const COPS_SYSTEM_ROLE_GRANTS = [
  { key: "sales", name: "Sales", permissionKeys: ["crm:read", "crm:write", "commercial:read", "commercial:send"] },
  {
    key: "sales_manager",
    name: "Sales Manager",
    permissionKeys: ["crm:read", "crm:write", "crm:admin", "commercial:read", "commercial:send", "commercial:approve", "analytics:read"],
  },
  {
    key: "cs",
    name: "Customer Success",
    permissionKeys: ["crm:read", "crm:write", "onboarding:read", "onboarding:write", "onboarding:send", "tickets:read", "tickets:write", "tickets:send", "analytics:read"],
  },
  {
    key: "finance",
    name: "Finance",
    permissionKeys: ["crm:read", "commercial:read", "commercial:write", "commercial:approve", "billing:read", "billing:write", "billing:refund", "credits:read", "credits:adjust"],
  },
  {
    key: "legal_revops",
    name: "Legal / RevOps",
    permissionKeys: ["crm:read", "commercial:read", "commercial:write", "commercial:approve", "legal:read", "legal:write", "legal:approve", "analytics:read"],
  },
  {
    key: "engineering",
    name: "Engineering",
    permissionKeys: ["crm:read", "tickets:read", "tickets:write", "tickets:admin", "analytics:read"],
  },
  {
    key: "product",
    name: "Product",
    permissionKeys: ["crm:read", "tickets:read", "analytics:read", "analytics:admin", "admin:read"],
  },
] as const;
