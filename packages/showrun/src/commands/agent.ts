/**
 * showrun agent - Run Exploration or Editor agents headlessly
 */

import { runHeadlessAgent } from '@showrun/dashboard';
import type { HeadlessAgentOptions } from '@showrun/dashboard';

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

export async function cmdAgent(args: string[]): Promise<void> {
  const subcommand = args[0];
  const commandArgs = args.slice(1);

  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    printAgentHelp();
    process.exit(EXIT_SUCCESS);
  }

  if (!['explore', 'editor'].includes(subcommand)) {
    console.error(`Error: Unknown agent type "${subcommand}". Use "explore" or "editor".`);
    process.exit(EXIT_FAILURE);
  }

  // Parse args
  let packId: string | null = null;
  let prompt: string | null = null;
  let conversationId: string | undefined;
  let headful = false;
  let verbose = false;
  let dataDir = './data';
  let packDirs: string[] = ['./taskpacks'];

  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    const next = commandArgs[i + 1];

    if (arg === '--conversation' && next) {
      conversationId = next;
      i++;
    } else if (arg === '--headful') {
      headful = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--dataDir' && next) {
      dataDir = next;
      i++;
    } else if (arg === '--packs' && next) {
      packDirs = next.split(',');
      i++;
    } else if (!arg.startsWith('-')) {
      if (!packId) {
        packId = arg;
      } else if (!prompt) {
        prompt = arg;
      }
    }
  }

  if (!packId || !prompt) {
    console.error(`Error: Missing required arguments for "${subcommand}".`);
    console.error(`Usage: showrun agent ${subcommand} <pack_id> <prompt> [options]`);
    process.exit(EXIT_FAILURE);
  }

  try {
    console.log(`Starting ${subcommand} agent for pack "${packId}"...`);
    if (conversationId) console.log(`Resuming conversation: ${conversationId}`);

    const result = await runHeadlessAgent({
      agentType: subcommand as 'explore' | 'editor',
      packId,
      prompt,
      conversationId,
      headful,
      verbose,
      dataDir,
      packDirs,
    });

    console.log('\n--- Agent Finished ---');
    console.log(`Conversation ID: ${result.conversationId}`);
    console.log('Final Output:');
    console.log(result.finalContent || '(No text output)');
    
    if (result.aborted) {
      console.log('\n(Agent was aborted)');
    }

    process.exit(EXIT_SUCCESS);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_FAILURE);
  }
}

export function printAgentHelp(): void {
  console.log(`
Usage: showrun agent <subcommand> <pack_id> <prompt> [options]

Run an AI agent headlessly from the CLI.

Subcommands:
  explore    Run the Exploration Agent (browse, research, plan)
  editor     Run the Editor Agent (implement flow, test)

Arguments:
  <pack_id>  The ID of the task pack to work on
  <prompt>   The instruction or question for the agent

Options:
  --conversation <id>    Resume an existing conversation by ID
  --headful              Show the browser window (for debugging)
  --verbose              Print detailed logs (tool calls, thinking)
  --dataDir <dir>        Directory for database and logs (default: ./data)
  --packs <dirs>         Comma-separated list of pack directories (default: ./taskpacks)

Examples:
  showrun agent explore my-pack "Find the login page and explain the auth flow"
  showrun agent explore my-pack "Click the login button" --conversation <prev_id>
  showrun agent editor my-pack "Implement the login steps"
`);
}
