# Relay

One chat panel in Home Assistant for your Claude Pro and ChatGPT Plus subscriptions. Messages run through the official Claude Agent SDK and Codex SDK, signed in with your own accounts, so nothing is billed per token.

## One-time setup

**Claude**

1. On a computer where you use Claude Code, run `claude setup-token` and sign in with your Claude Pro account.
2. Paste the token into this add-on's **Configuration** tab (Claude token) and save.
3. Restart the add-on.

**ChatGPT**

1. Open **Relay** from the sidebar and select **Accounts**.
2. Select **Connect ChatGPT**. A link and a one-time code appear.
3. Open the link on any device, sign in with your ChatGPT Plus account and enter the code.

The login is stored in the add-on's private data folder and survives restarts and updates.

## Using it

Leave the three controls on **Auto** and Relay decides per message:

- **Who**: quick questions go to your default chat provider, multi-step work to your default agent provider. A chat stays with the provider that started it unless you pick the other one.
- **How**:
  - *Chat* is a single, tool-free request and uses very little of your limits. If the model decides your question needs current information, Relay automatically reruns it as a look-up.
  - *Look up* can read Home Assistant and search the web, limited to a few steps. It's used for questions about your home, the weather, news, scores, prices and anything else current.
  - *Agent* can run commands, edit files, search the web and read Home Assistant. It's used when your message mentions files, code, errors, configs and similar.
- **Effort**: low for chat, medium for agent work, high when you ask for careful thinking.

Turn on **Hard problem** to use the bigger Claude model (Opus by default) or high reasoning effort on ChatGPT.

Agent work happens in `/share/relay/workspace`. You can reach that folder through the Samba add-on.

## Files

Ask for a file ("save that as a Word document", "make me a spreadsheet of this") and the agent creates it in the workspace. Every file a reply creates or changes appears under that reply as a download button. **Files** in the sidebar lists everything in the workspace, newest first.

The agents can write any text format directly and convert with pandoc (Markdown to Word, PowerPoint, HTML, ODT, EPUB) or Python with python-docx, openpyxl (Excel) and python-pptx.

If you ask for a file in a quick chat, Relay switches to agent mode automatically, and follow-ups like "now as a docx" stay in agent mode.

## Copying and exporting chats

Open a chat and use the buttons at the top:

- **Copy chat** copies the conversation as plain text: who said what, nothing else.
- **Export log** downloads a plain-text (.txt) file with everything: each message with its time, which provider, mode and effort answered, every step (searches, commands, file edits, Home Assistant lookups) with its result and command output, any errors or usage-limit notices, and token counts. Command output in the log is the same shortened version the panel shows.

## Home Assistant access

With **Let models read Home Assistant** on (the default), both models get three read-only tools: find entities (by name, domain or area), read one entity's state and attributes, and get your weather forecast. Weather questions use your HA weather entity first and only fall back to the web.

The models never see the Home Assistant token. Their tools call back into Relay, which only answers these read-only questions. Nothing can be turned on, off, opened or changed. Use **Hide these entities** to keep specific entities out of reach, for example `camera.*`.

## Recent events and your area

Look-up and agent requests are told today's date and where you live, so searches about scores, news or prices target this week instead of past seasons. Relay takes your location from Home Assistant. If your HA location is just named "Home", set **Your area** (for example `Charlotte, NC`) on the Configuration tab so ambiguous questions, like which "Panthers", pick the local one.

## Usage limits

Everything here counts against the same limits as claude.ai, ChatGPT, Claude Code and Codex. When one provider hits its limit, Relay offers to continue the chat with the other one, passing along a short summary instead of the whole transcript.

## What keeps usage low

- Chat mode sends no tools and a one-line system prompt.
- No CLAUDE.md, user settings or MCP servers are loaded.
- Command output is capped (**Command output cap**) before it goes back to the model.
- Long chats are summarized and continued in a fresh session once they pass **Compact long chats at**.
- The start of each request stays the same between turns, so caching keeps working.

## Safety notes

- The panel is only reachable through Home Assistant (ingress). It does not open any ports.
- In agent mode the models can run commands inside this add-on's container and read or write anything under `/share`. Don't keep secrets there.
- API keys are stripped from the agents' environment, so usage always comes from your subscriptions.
- This is a personal tool on your own accounts. Don't share access with other people.
