// The sidebar groups pages by what people manage, not by the setup path. Each group
// lists its main pages first; the rest of its record types sit under "More", so every
// page the setup path reaches stays one click from the sidebar. The setup path itself
// is the "Program setup" card on the overview.
//
// A link names a resource type (`type`), an app route (`href`), or a server page that
// only some workspaces have (`server`: the body data attribute that holds its URL).
// Links to record types the active model does not define are left out when rendered.
export const NAV_GROUPS = [
  {
    id: "my-work",
    title: "My work",
    icon: "check",
    links: [
      { server: "actionsHref", href: "#/actions", label: "Actions", route: "actions" },
      { server: "acknowledgementsHref", label: "My policies and training" }
    ]
  },
  {
    id: "monitoring",
    title: "Monitoring",
    icon: "pulse",
    links: [
      { type: "automated-check", label: "Checks" },
      { href: "#/stage/run", label: "Work queue", route: "stage:run" },
      { type: "obligation", label: "Obligations" }
    ],
    more: [
      { type: "obligation-event", label: "Policy events" },
      { type: "action-item", label: "Action items" }
    ]
  },
  {
    id: "compliance",
    title: "Compliance",
    icon: "shield",
    links: [
      { type: "control", label: "Controls" },
      { href: "#/policies", label: "Policies", route: "policies" },
      { type: "evidence", label: "Evidence" },
      { href: "#/evidence-sources", label: "Evidence sources", route: "evidence-sources" },
      { type: "framework", label: "Frameworks" }
    ],
    more: [
      { type: "requirement", label: "Requirements" },
      { type: "requirement-mapping", label: "Requirement mappings" },
      { type: "commitment", label: "Commitments" },
      { type: "complementary-control", label: "Complementary controls" },
      { href: "#/retention-schedule", label: "Data retention schedule", route: "retention-schedule" },
      { type: "program", label: "Programs" }
    ]
  },
  {
    id: "data-library",
    title: "Data library",
    icon: "database",
    links: [
      { type: "person", label: "People" },
      { type: "training", label: "Training" },
      { type: "access-review", label: "Access reviews" },
      { type: "vendor", label: "Vendors" },
      { type: "risk", label: "Risks" },
      { type: "incident", label: "Incidents" }
    ],
    more: [
      { type: "access-grant", label: "Access grants" },
      { type: "service-account", label: "Service accounts" },
      { type: "attestation", label: "Attestations" },
      { type: "vendor-review", label: "Vendor reviews" },
      { type: "risk-assessment", label: "Risk assessments" },
      { type: "system", label: "Systems" },
      { type: "component", label: "Components" },
      { type: "asset", label: "Assets" },
      { type: "classification", label: "Classifications" },
      { type: "information-type", label: "Information types" },
      { type: "vulnerability", label: "Vulnerabilities" },
      { type: "vulnerability-scan", label: "Vulnerability scans" },
      { type: "penetration-test", label: "Penetration tests" },
      { type: "backup-test", label: "Backup tests" },
      { type: "exercise", label: "Exercises" },
      { type: "finding", label: "Findings" },
      { type: "policy-review", label: "Policy reviews" },
      { type: "meeting", label: "Meetings" },
      { type: "exception", label: "Exceptions" },
      { type: "data-request", label: "Data requests" },
      { type: "appointment", label: "Appointments" },
      { type: "team", label: "Teams" },
      { type: "reporting-route-set", label: "Reporting channel sets" }
    ]
  },
  {
    id: "audits",
    title: "Audits",
    icon: "clipboard",
    links: [
      { type: "audit", label: "Audits" },
      { href: "#/audit-packet", label: "Audit packet", route: "audit-packet" },
      { server: "auditorLinksHref", label: "Auditor links" }
    ],
    more: [
      { type: "audit-request", label: "Audit requests" },
      { type: "audit-population", label: "Audit populations" },
      { type: "control-test", label: "Control tests" },
      { href: "#/resources/document?documentScope=audit", label: "Audit documents", route: "audit-documents" }
    ]
  }
];

// Outline icons, 18 px, drawn on a 24 px grid with a 1.6 stroke.
export const NAV_ICONS = {
  home: '<path d="M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9V6z"/><path d="m9 12 2 2 4-4.5"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5h6v3H9zM8.5 12h7M8.5 16h5"/>'
};

// Every page the sidebar links to, as route keys: "type:<resource type>" for a record
// list and "route:<name>" for an app page. Tests use it to prove no page fell out.
export function navigationRouteKeys(groups = NAV_GROUPS) {
  return groups.flatMap((group) => [...group.links, ...(group.more || [])]).map((link) => (
    link.type ? `type:${link.type}` : link.server ? `server:${link.server}` : `route:${link.route}`
  ));
}
