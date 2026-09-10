function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function snapField(snapshot: Record<string, unknown>, key: string): string {
  const value = snapshot[key];
  return value == null ? "" : String(value);
}

export function buildListCsv(
  listName: string,
  members: Array<{
    prospectId: string;
    snapshot: Record<string, unknown>;
    score?: { score?: number | null } | null;
  }>
): { filename: string; content: string } {
  const headers = [
    "Full Name",
    "Title",
    "Company Domain",
    "Industry",
    "Country",
    "Email",
    "Email Status",
    "ICP Score",
  ];
  const rows = members.map((member) => {
    const snap = member.snapshot ?? {};
    return [
      snapField(snap, "fullName") || snapField(snap, "companyName") || member.prospectId,
      snapField(snap, "title"),
      snapField(snap, "companyDomain") || snapField(snap, "companyName"),
      snapField(snap, "industry"),
      snapField(snap, "country"),
      snapField(snap, "email"),
      snapField(snap, "emailStatus"),
      member.score?.score != null ? String(member.score.score) : "",
    ];
  });

  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const filename = `${listName.replace(/[^a-z0-9]/gi, "-").toLowerCase() || "list"}.csv`;
  return { filename, content };
}
