import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentGuidedTour, useGuidedTour } from "./AgentGuidedTour";

function TourHarness() {
  const { active, session, start, complete } = useGuidedTour();
  return (
    <div data-tour-sidebar>
      <button type="button" onClick={start}>使用引导</button>
      <div data-tour="header" />
      <AgentGuidedTour key={session} active={active} onComplete={complete} />
    </div>
  );
}

describe("AgentGuidedTour", () => {
  it("does not start automatically and can be reopened from the beginning", () => {
    render(<TourHarness />);

    expect(screen.queryByRole("dialog", { name: "ProjectFlow 使用引导" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "使用引导" }));
    expect(screen.getByRole("dialog", { name: "ProjectFlow 使用引导" })).not.toBeNull();
    expect(screen.getByText("项目旅程")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "跳过引导" }));
    expect(screen.queryByRole("dialog", { name: "ProjectFlow 使用引导" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "使用引导" }));
    expect(screen.getByText("项目旅程")).not.toBeNull();
  });

  it("falls back safely when a step target is not rendered", () => {
    const onComplete = vi.fn();
    render(<AgentGuidedTour active onComplete={onComplete} />);

    expect(screen.getByRole("dialog", { name: "ProjectFlow 使用引导" })).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
