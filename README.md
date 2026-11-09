# Reflect

Reflect is an Obsidian plugin for coming back to what you’ve written. It brings related passages together so you can see which ideas keep coming up. Each passage links back to the note it came from.

**Pre-alpha.** I’m still exploring how Reflect can help you come back to your notes. The workflow may change as I learn what people find useful.

## Why I built Reflect

I write down things I notice as I go through the day. It might be something about how I work, or how I feel after spending time with someone. Sometimes I know why it matters to me. Other times I just have a feeling there’s more to it, and I want to come back when I’ve had a little time to think.

After a while, I had years of notes like this. I tried tagging them so I could find things again. At some point I caught myself thinking about where a thought belonged before I’d even written it down. It made me write less.

I wanted to go back through my notes and see what I kept thinking about. A note about a decision at work might have something in common with one I’d written months earlier about a friendship. I’d written them for different reasons, but reading them together might show me I’d been turning over the same question for a while.

That’s how I ended up building Reflect. It brings related passages together in Obsidian so I can read what I actually wrote and see what I make of it now. If an idea feels worth coming back to, I can keep it as a note of its own, with links to the notes that led me there. And something I write next week might give me a reason to read them all again.

## Install

Reflect requires Obsidian Desktop 1.15.0 or later. This release has been tested on macOS.

For a manual install, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/faradayfury/reflect/releases/latest). Put them in your vault's `.obsidian/plugins/reflect` folder. Restart Obsidian, open **Settings → Community plugins**, and enable **Reflect**.

## Use Reflect

- Open **Reflect** to see recent passages in **Browse**. You can also browse by date, people and places, themes, or projects without setting up a model.
- Select **Find ideas in my notes** to look for recurring ideas across the vault. Review what the scan sends to OpenAI before you select **Run scan**. Reflect opens the first idea alongside the passages it found.
- Open **Ideas** to read drafts and kept ideas. **Keep idea** saves a Markdown note with links to its sources. To add links back from the source notes, select **Choose source links** before keeping the idea.
- Choose **Reflect on this note** in a note’s menu or the command palette. Select **Find related ideas**, read the quoted passages, and choose **Add source** if the note adds something to an idea.
- Select **Look for more ideas** from **Ideas** to find new drafts or more sources for ideas you already have.
- **Ask your notes** to explore a question across your vault and save the findings with their original passages.

## Set up the models

Install and start Ollama for local suggestions, then run `ollama pull qwen3:4b`. Reflect checks the local Ollama ports `11434` and `11439`. [Download Ollama](https://ollama.com/download)

Astra features require the Codex CLI and an account with access to Astra. Install the CLI and run `codex login`. To check your setup, run `codex login status` or `ollama list` in Terminal. [Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli)

Reflect is free and can browse passages without an account. The optional Astra features use your own OpenAI account and may require a paid plan or usage credits.

## Data and privacy

Reflect reads Markdown and keeps its review data in your vault. It updates notes when you choose to keep an idea, add a source, or save a link.

- **Ollama.** Local discovery can run in the background when the vault is open. Reflect sends relevant note excerpts, idea summaries, and review preferences to Ollama on your computer for suggestions and feedback rechecks.
- **Astra.** When you run an Astra scan or submit a question, Reflect sends eligible note text, titles, dates, and relevant review context to OpenAI through your signed-in Codex CLI. Reflect starts the external CLI and uses a temporary system directory outside your vault for the answer. It removes that directory after the request.

## License

Reflect is licensed under the [MIT License](LICENSE). The bundled Newsreader typeface is licensed separately under the [SIL Open Font License](Newsreader-OFL.txt).
