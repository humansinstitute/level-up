import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader, LEVELUP_ADMIN_NPUB, TeamChooserView, TeamProjectsView, type Team } from "./App";

const noop = () => undefined;
const team = (id: string, name: string, isOrganiser: boolean): Team => ({
  id, sessionId: `session-${id}`, name, phase: "lobby", isOrganiser,
  members: [{ accountId: `account-${id}`, npub: "npub1member", role: isOrganiser ? "organiser" : "player" }],
  projects: [{ id: `project-${id}`, teamId: id, name: `${name} Game`, phase: "selecting_template", selectedTemplateId: null, stablePlayUrl: null, createdAt: 1 }],
});

function chooser(userNpub: string) {
  return renderToStaticMarkup(<TeamChooserView userNpub={userNpub} teams={[team("one", "First Crew", true), team("two", "Second Crew", false)]} teamName="" joinInput="" busy={false} onTeamName={noop} onJoinInput={noop} onCreate={noop} onJoin={noop} onOpenTeam={noop} />);
}

describe("team permission and navigation presentation", () => {
  test("shows Pete the creation form alongside every team and invite joining", () => {
    const html = chooser(LEVELUP_ADMIN_NPUB);
    expect(html).toContain("First Crew");
    expect(html).toContain("Second Crew");
    expect(html).toContain("2 total");
    expect(html).toContain("Create team");
    expect(html).toContain("Join team");
  });

  test("replaces team creation with restriction copy but keeps joining actionable for other users", () => {
    const html = chooser("npub1ordinarymember");
    expect(html).toContain("New team creation is currently limited to Pete");
    expect(html).not.toContain("Team name");
    expect(html).not.toContain("Create team");
    expect(html).toContain("Join team");
    expect(html).toContain('placeholder="https://…/#join=…"');
  });

  test("shows project creation only to the team creator", () => {
    const creator = renderToStaticMarkup(<TeamProjectsView team={team("one", "First Crew", true)} projectName="" busy={false} onProjectName={noop} onCreateProject={noop} onOpenProject={noop} />);
    const member = renderToStaticMarkup(<TeamProjectsView team={team("two", "Second Crew", false)} projectName="" busy={false} onProjectName={noop} onCreateProject={noop} onOpenProject={noop} />);
    expect(creator).toContain("Create project");
    expect(member).not.toContain("Create project");
    expect(member).not.toContain("Only the account that created this team can create a project");
    expect(member).toContain("Second Crew Game");
  });

  test("offers All teams navigation from team and project surfaces", () => {
    const profile = { pubkey: "1".repeat(64), npub: "npub1member", displayName: "Player", metadata: {} };
    const nested = renderToStaticMarkup(<AppHeader user={{ npub: "npub1member" }} profile={profile} busy={false} atHome={false} onHome={noop} onEdit={noop} onManageGames={noop} onLogout={noop} />);
    const chooserHeader = renderToStaticMarkup(<AppHeader user={{ npub: "npub1member" }} profile={profile} busy={false} atHome onHome={noop} onEdit={noop} onManageGames={noop} onLogout={noop} />);
    expect(nested).toContain("← All teams");
    expect(chooserHeader).not.toContain("← All teams");
  });
});
