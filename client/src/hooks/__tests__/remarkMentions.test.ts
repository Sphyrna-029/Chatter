import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMentions } from "@/lib/remarkMentions";

const render = (md: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkMentions] }, md),
  );

describe("remarkMentions", () => {
  it("marks each @name in text", () => {
    expect(render("hey @buck and @mod_team!")).toBe(
      '<p>hey <span data-mention="buck">@buck</span> and <span data-mention="mod_team">@mod_team</span>!</p>',
    );
  });

  it("finds mentions inside formatting", () => {
    expect(render("**@buck** look")).toBe(
      '<p><strong><span data-mention="buck">@buck</span></strong> look</p>',
    );
  });

  it("leaves code alone", () => {
    expect(render("`@buck`")).toBe("<p><code>@buck</code></p>");
    expect(render("```\n@buck\n```")).not.toContain("data-mention");
  });

  it("does not read an email address as a mention", () => {
    expect(render("write to a@b sometime")).not.toContain("data-mention");
  });

  it("leaves a bare @ as text", () => {
    expect(render("meet @ noon")).toBe("<p>meet @ noon</p>");
  });
});
