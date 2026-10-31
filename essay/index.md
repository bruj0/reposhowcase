
# How Agents Made a Small Idea Worth Building

I wanted a catalogue of my open-source work for years. Agents changed the cost of getting from the idea to a working product, but experience still had to guide every important choice.

The result became [Repo Showcase](https://github.com/bruj0/reposhowcase), a static catalogue and a reusable agent-guided workflow for publishing one person's repositories.

I wanted a page for the open-source applications I had written over the years. There were about fifty worth showing, spread across infrastructure, security, software delivery, and developer tooling.

The need was simple. The work behind it was not.

I would need to choose a static-site generator, decide where to host the page, work out how to collect repository data, define which projects belonged, create a useful set of filters, handle credentials, automate deployment, and decide how to keep the catalogue current. Each choice led to several more.

The site would be useful, but not useful enough to justify weeks of spare-time research and implementation. I had postponed it for years for a sensible reason: the likely reward was smaller than the cost of producing and maintaining it.

Agents changed that calculation.

I could delegate much of the research, comparison, code generation, and verification. My platform engineering experience still mattered because someone had to judge the options, find weak assumptions, and guide the work toward a maintainable result. The agent reduced the cost of applying that experience across hundreds of small decisions.



**Agents made the idea practical because they reduced the cost of exploring choices and carrying out a plan. They did not remove the need for engineering judgement. They gave me enough reach to apply it throughout the project.**

<p style="font-size: small; color: #6b7280; margin-top: 0.5em;">By Rodrigo A. Diaz Leven · <a href="https://www.linkedin.com/in/rodrigoleven/">LinkedIn</a> · <a href="https://github.com/bruj0">GitHub</a> · <a href="https://resume.bruj0.net/bruj0/rodrigo-leven">Resume</a></p>

## Table of contents

- [A small idea with a large decision surface](#a-small-idea-with-a-large-decision-surface)
- [Research changed the economics of the project](#research-changed-the-economics-of-the-project)
- [The stack followed the constraints](#the-stack-followed-the-constraints)
- [Research needs an engineer in the loop](#research-needs-an-engineer-in-the-loop)
- [Planning turned the answer into an executable sequence](#planning-turned-the-answer-into-an-executable-sequence)
- [My agent environment carried the working method](#my-agent-environment-carried-the-working-method)
- [Implementation became a series of bounded conversations](#implementation-became-a-series-of-bounded-conversations)
- [A real instance kept the abstraction honest](#a-real-instance-kept-the-abstraction-honest)
- [What agents changed for this class of idea](#what-agents-changed-for-this-class-of-idea)
- [The practical method I would use again](#the-practical-method-i-would-use-again)
- [Limits](#limits)
- [Conclusion](#conclusion)
- [About the author](#about-the-author)

## A small idea with a large decision surface

“Put my projects on a page” sounds like a weekend task. It can be, if the page is disposable.

I wanted something I could keep. That added questions before I wrote any code.

Was this a portfolio with ten featured projects or a catalogue of everything substantial? Should the page call GitHub whenever someone opened it, or should a build create static data? How would I distinguish projects I created from forks I kept for reference? Would repository language make a useful filter? How would I classify a Terraform module, a deployment tool, and an engineering essay without creating dozens of categories?

The operational questions were just as numerous. I needed to choose between Astro, Hugo, Eleventy, a React application, or plain HTML. I had to compare GitHub Pages, Cloudflare Pages, and paid hosting. A private source repository complicated some hosting options. A custom domain brought DNS and certificate work. Automated deployment required a credential, and that credential needed the smallest practical permissions.

Maintenance added another set. The page had to survive a GitHub API failure. It needed a refresh process for new repositories. A future change in branding should not require edits across many source files. If I released the project as a template, a new user should not publish my catalogue under their name by accident.

None of these decisions was especially hard on its own. Their combined cost had kept the idea in my backlog.

This is a common reason small tools remain unbuilt. The code is manageable, but the research, integration, and maintenance decisions make the effort hard to justify. A programmer can build the visible feature in a few evenings and still spend much longer working out the surrounding system.

## Research changed the economics of the project

I began with a research task rather than a coding prompt.

The agent received the outcome and the constraints: publish a catalogue of the public repositories I owned, exclude forks and weak entries, keep the source private, avoid a runtime service, and minimise ongoing cost. It inspected the account, read current documentation, compared tools, and recorded the evidence in a research note.

That first pass established the size and shape of the problem. My account had 66 public, non-fork repositories. Three were empty. Ten had no stars, views, or substantial content. Fifty-three belonged in the first catalogue.

The count mattered. Ten featured projects might fit a hand-written portfolio. Fifty-three needed filters, consistent metadata, and an automated refresh. It also showed why language alone would be a poor organising principle. Python, Go, Shell, Terraform, and PHP described implementation, while a visitor would care more about purpose and target platform.

The agent compared generators against the actual page rather than producing a generic list of popular frameworks. The site needed static HTML and a small amount of browser-side filtering. It did not need a server or a full client-rendered application. Astro, Hugo, and Eleventy all remained credible. Astro offered a direct fit because it rendered static HTML by default and let the filter carry the only client-side JavaScript.

Hosting research narrowed the next choice. The original instance lived in a private repository and produced a public site. GitHub Pages on my free plan could not publish directly from that private source. Cloudflare Pages could accept a built folder through Direct Upload without receiving repository access. Its free tier covered the expected use, so paying for a server would have added cost and operations without improving the result.

The research also addressed data freshness. Fetching GitHub at request time would keep the page current, but it would introduce a runtime, API limits, and another failure path. A committed JSON snapshot gave me static builds, reviewable changes, and a page that kept working when GitHub was unavailable. Refreshing the snapshot became an explicit maintenance action.

By the end of the research stage, I had a reasoned set of choices:

| Concern | Choice | Reason |
|---|---|---|
| Site generator | Astro | Static output with JavaScript limited to the filter |
| Hosting | Cloudflare Pages | Free public hosting from a private source through Direct Upload |
| Repository data | Committed JSON snapshot | Reviewable diffs and no runtime dependency on GitHub |
| Catalogue scope | Public, owned, non-fork repositories that pass explicit rules | The page represents work I created and still want to present |
| Organisation | Purpose, platform, and language | Readers can find relevant work without relying on one technical dimension |

The agent did most of the collection and comparison. I reviewed whether the facts supported the recommendations. That division saved time without turning the decision into a popularity contest between tools.

## The stack followed the constraints

It would have been easy to choose Astro because it was current, or Cloudflare because I already used it. Research made the choices easier to defend and easier to change.

Hugo would have produced an excellent static site. Its speed offered little practical advantage for one page and fifty-three records. Astro fit my existing TypeScript tooling and made the interactive filter straightforward. That was enough. I did not need to prove that every other generator was bad.

The hosting choice followed the same pattern. I did not need a virtual machine for three static files. A paid host would not make the catalogue more accurate. Cloudflare Direct Upload let my own workflow build the site and send only the result. The host did not need read access to the private source repository.

Some choices emerged only after comparing approaches. Cloudflare's Git integration looked convenient, but it required a browser OAuth grant and repository access. It also committed the project to that integration mode. Direct Upload kept the build under my control and left open a future move to another static host.

The deploy credential needed separate thought. A broad account token would work, but it would give a simple site more authority than it deserved. The setup script therefore creates or accepts a Pages-only token. DNS changes use narrower, short-lived credentials. The standing deployment token cannot edit DNS.

These are platform engineering decisions applied to a personal site. They are also the reason I could guide the agent efficiently. I knew what kinds of coupling, permissions, and failure modes to question. The agent could inspect documentation and implement the answer once I chose the boundary.

**Experience supplied the questions. The agent made it affordable to pursue each answer and preserve it in code, configuration, or documentation.**

## Research needs an engineer in the loop

Agent research is fast, but speed does not guarantee a sound conclusion.

A later investigation into GitHub Pages corrected part of the first hosting analysis. A private repository could not publish a Pages site on my plan, but a separate public repository could hold only the built artifact. That two-repository arrangement kept the source private while giving GitHub Pages a public branch to serve.

The first conclusion had treated the source repository and publishing repository as the same object. The correction did not invalidate Cloudflare Pages for the main site. Cloudflare still handled several custom domains better, and the existing deployment worked. The new evidence added GitHub Pages as a useful second target and removed an unnecessary limitation from the reusable product.

This is how I want agent research to work. The output is a decision record, not scripture. Another agent or a later session can test an assumption, cite better evidence, and change the plan. Because the reasoning lives in files, the correction updates the project's memory rather than remaining in one chat transcript.

My role was to notice where an assumption constrained the design and ask for a focused investigation. The agent found the mechanisms, checked the live account, and documented which parts of the earlier argument still held.

## Planning turned the answer into an executable sequence

Research answered what to build and why. I still needed a safe order for the work.

A vague instruction such as “turn this site into an agentic template” would have produced a large change with many hidden dependencies. I asked the agent to create a plan with ordered work packages, explicit prerequisites, and acceptance commands.

The plan separated the project into stages:

| Stage | Work |
|---|---|
| Establish the contract | Put identity, catalogue policy, taxonomy, and sorting in validated configuration |
| Remove instance assumptions | Replace hardcoded account data and fix the empty first-run experience |
| Give scripts an agent-friendly interface | Add dry-run and machine-readable output, with consistent errors |
| Encode the workflow | Write focused skills for identity, curation, tagging, sorting, audit, deployment, and launch |
| Prove behaviour | Compare the new implementation with the live site |
| Extract the product | Separate the reusable public template from my configured instance |
| Test a stranger's path | Publish a small catalogue from prose without editing application code |

The implementation plan eventually contained thirteen work packages. The first established the config contract because identity, filters, and scripts all depended on it. The skills came later because they needed stable commands and file ownership. Parity testing came before extracting the template. A smoke test on a separate account came last because success on the author's machine proves very little about reuse.

Each package ended with a command or observable result. A build had to reject an unknown tag by name. A renamed instance had to contain no trace of the old identity. The public template had to contain no private catalogue data. The deployed smoke-test site had to return the expected number of cards.

This planning stage reduced review cost. Instead of asking an agent for one large implementation, I could review one boundary at a time. Failures changed the next step while the rest of the plan stayed readable.

## My agent environment carried the working method

The project moved through several agent sessions. A long initial prompt would not have preserved enough context.

I used the repository as the shared memory. `AGENTS.md` files recorded conventions and boundaries. Research notes kept source comparisons and rejected options. The plan preserved sequence and dependencies. Repository-local skills described repeatable procedures and the checks that completed them.

That environment meant a new agent did not have to rediscover the whole project from commit history. It could read why the site used a committed snapshot, why tags came from a closed vocabulary, and why deployment used Direct Upload. The instructions also stated where the agent had to stop for a person, such as creating a credential in a browser or approving a destructive DNS change.

The skills became part of the application. A user can ask the agent to point the site at another account, change the inclusion rule, sort by stars, audit weak READMEs, or publish the result. Each skill owns a small part of the state and names the script that checks it.

This is the same environment I use for other agent-assisted engineering work. The domain changes, but the structure holds:

- durable project guidance in `AGENTS.md`;
- focused skills for recurring procedures;
- research notes for decisions that depend on external facts;
- a plan for work with dependencies;
- deterministic checks at the end of each bounded change.

The agent had more than a request. It had a working method.

## Implementation became a series of bounded conversations

Once the research and plan existed, implementation stopped feeling like one large act of generation.

I could ask for the config contract and review the schema before touching the UI. I could test the empty state with an empty repository list. I could inspect how the curation rules treated the 66 candidates. When the tag classifier produced false positives, I changed the design so the agent inspected each repository and selected from a closed vocabulary.

The agent still wrote a large amount of code. It created the Astro components, fetch and deployment scripts, validation logic, docs, and skills. The important difference was that each change had a local purpose and a test.

Several defects appeared during this process. An identity check searched for the original site name, which could never catch a failed rename for a different user. Cloudflare provisioning succeeded while an old forwarding rule sent the public URL elsewhere. An unauthenticated refresh ran out of GitHub requests and risked producing a catalogue where healthy repositories looked empty.

Each failure improved the workflow. The identity skill now searches for the name being replaced. Deployment fetches the public URL before reporting success. Refresh aborts on incomplete data instead of writing a plausible but damaged snapshot.

Those corrections are a large part of the product. Code generation produced the first version quickly. The planned checks exposed where the first version was wrong.

## A real instance kept the abstraction honest

I built Repo Showcase from CodersCorp, the working catalogue for my own repositories. I kept the old site running while I built a second implementation next to it.

That gave the agent a concrete target. The new version had to show the same 53 repositories, tags, filter buttons, card fields, and sort order. A comparison script checked both deployments.

Only after parity passed did I extract the reusable public repository. The release process removed my identity, domains, and catalogue, then added a small sample so a fresh clone rendered a useful page. A release check compared the product with the instance and refused private data.

The final smoke test used another account and a one-repository allowlist. The agent configured and published the site from prose without changing files under `src/`. That proved the interface I cared about: a user could describe the catalogue they wanted, and the skills plus scripts could produce it.

Building against a real instance also prevented speculative features. I had actual repositories, real API limits, existing DNS, and an old site to compare. The agent could investigate concrete failures instead of designing for imagined ones.

## What agents changed for this class of idea

Before I used agents this way, the project had an unattractive cost profile. Most of the effort sat outside the final page:

- reading product and hosting documentation;
- comparing several valid stacks;
- checking account limits and API behaviour;
- turning preferences into configuration;
- writing deployment automation and verification;
- documenting enough of the system to maintain it later.

I could do all of that, but the result did not warrant the time.

Agents reduced the marginal cost of each step. A focused research request could compare hosting mechanisms and return evidence. A planning request could turn decisions into work packages. An implementation session could complete one package and run its acceptance checks. Another agent could review a specific assumption without reopening the whole design.

My experience increased the value of that speed. I could reject a full React runtime for a mostly static page, question a broad token, prefer a committed snapshot over a runtime dependency, and insist on a live URL check after deployment. Someone still had to know which trade-offs mattered.

The project became viable when generation and judgement worked together. The agent covered more ground than I would have justified covering alone. I kept the work aimed at a result I could operate and reuse.

## The practical method I would use again

For another postponed idea, I would follow the same sequence.

### State the need and the constraints

Describe the result in ordinary language. Include cost, privacy, maintenance, and operational limits. Avoid choosing the stack in the first sentence unless a real constraint has already chosen it.

### Ask for research that ends in a recommendation

Require current evidence, viable alternatives, rejected options, and open decisions. Store the result in the repository so later work can test its assumptions.

### Review the decision, not every search step

Use experience to challenge coupling, permissions, failure handling, and maintenance. Ask a narrower follow-up when a conclusion rests on an assumption.

### Convert the decision into ordered work

Give each work package an observable acceptance check. Record dependencies. Put contracts and validation before orchestration.

### Teach the agent environment

Keep stable guidance in `AGENTS.md`. Add a skill when a procedure will recur. Let skills call scripts rather than restating implementation logic in prose.

### Implement in bounded slices

Review small changes against the plan. When a check exposes a bad assumption, update the workflow as well as the code.

### Prove the user's path

Test the result from a clean or separate instance. If the product promises configuration through conversation, verify that the agent can produce the result without source edits.

This process still takes work. It directs the expensive human attention toward choices and evidence, while agents handle much of the collection and execution.

## Limits

Repo Showcase suited this approach because the risk was controlled. It publishes public repository metadata and static files. A mistake could break a site or misclassify a project, but it could not move money or expose customer records.

Higher-risk systems need stronger review, tests, and authority boundaries. An agent should not choose a destructive migration because its research summary sounds convincing. The same method can help, but the acceptance evidence and human approvals must match the consequences.

Agents also create review volume. A detailed plan can still produce too much code at once if the implementation ignores its package boundaries. I had to keep sessions focused and read the outputs that carried policy, especially config validation, credential scope, and deployment behaviour.

Research can be wrong or incomplete. The correction to the GitHub Pages analysis is evidence of that. Saving the reasoning made the mistake repairable; it did not make the first answer automatically correct.

## Conclusion

I had postponed a useful idea because its surrounding decisions cost more than the page seemed worth. Agents lowered that cost enough for me to proceed.

Research narrowed the options before code made any of them expensive. Planning turned the recommendation into a sequence I could review. Repository guidance and skills kept the method available across sessions. Deterministic scripts handled the repeated work and supplied evidence at each boundary.

My platform experience remained central. It helped me ask about static output, private source, token scope, runtime dependencies, DNS safety, and maintenance. The agent let me apply those questions across the whole project without spending weeks on every detail myself.

**Turning an idea into reality with agents means using them to extend judgement, not bypass it. Research the choices, decide with evidence, plan the sequence, and make every implementation step prove what it changed.**

Repo Showcase exists because that process made a modest idea economically sensible. I expect many useful internal tools, personal projects, and small products are waiting behind the same calculation.

---

## About the author

**Rodrigo A. Diaz Leven** is a platform engineering lead focused on AI-assisted engineering, software delivery, and developer tooling.

If this essay sparked a question, disagreement, or an example from your own work, he would like to hear it:

- LinkedIn: <https://www.linkedin.com/in/rodrigoleven/>
- GitHub: <https://github.com/bruj0>
- Resume: <https://resume.bruj0.net/bruj0/rodrigo-leven>
