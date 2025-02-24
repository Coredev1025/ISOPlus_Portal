import WorkspaceDetail from './WorkspaceDetail';

export const workspaces = {
  "ws-001": { id: "ws-001", name: "Marketing Team", boards: [
    { id: "board-001", name: "Q1 Campaigns" },
    { id: "board-002", name: "Social Media Calendar" }
  ]},
  "ws-002": { id: "ws-002", name: "Development Team", boards: [
    { id: "board-003", name: "Sprint Planning" },
    { id: "board-004", name: "Bug Tracking" }
  ]},
  "ws-003": { id: "ws-003", name: "Sales Department", boards: [
    { id: "board-005", name: "Lead Pipeline" },
    { id: "board-006", name: "Client Meetings" }
  ]},
  "ws-004": { id: "ws-004", name: "Customer Support", boards: [
    { id: "board-007", name: "Ticket Overview" }
  ]},
  "ws-005": { id: "ws-005", name: "Human Resources", boards: [
    { id: "board-008", name: "Recruitment Pipeline" }
  ]},
  "ws-006": { id: "ws-006", name: "Product Management", boards: [
    { id: "board-009", name: "Product Roadmap" },
    { id: "board-010", name: "Feature Requests" }
  ]},
  "ws-007": { id: "ws-007", name: "Finance Team", boards: [
    { id: "board-011", name: "Budget Planning" }
  ]},
  "ws-008": { id: "ws-008", name: "Design Studio", boards: [
    { id: "board-012", name: "Project Designs" }
  ]},
  "ws-009": { id: "ws-009", name: "Operations", boards: [
    { id: "board-013", name: "Process Improvement" }
  ]},
  "ws-010": { id: "ws-010", name: "Research & Development", boards: [
    { id: "board-014", name: "Innovation Projects" }
  ]},
  "ws-011": { id: "ws-011", name: "Quality Assurance", boards: [
    { id: "board-015", name: "Test Cases" }
  ]},
  "ws-012": { id: "ws-012", name: "Legal Department", boards: [
    { id: "board-016", name: "Contract Review" }
  ]},
  "ws-013": { id: "ws-013", name: "IT Infrastructure", boards: [
    { id: "board-017", name: "System Maintenance" }
  ]},
  "ws-014": { id: "ws-014", name: "Content Creation", boards: [
    { id: "board-018", name: "Content Calendar" }
  ]}
};

export function generateStaticParams() {
  return Object.keys(workspaces).map((id) => ({
    id: id,
  }));
}

export default function Page({ params }: { params: { id: string } }): JSX.Element {
  return <WorkspaceDetail params={params} />;
}