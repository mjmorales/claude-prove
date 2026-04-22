import { Command } from '@oclif/core';

/**
 * Base class for placeholder topic commands. Each topic in the CLI renders
 * a short "not yet implemented" notice citing the port phase that will
 * replace it with real logic. See:
 * .prove/decisions/2026-04-21-typescript-cli-unification.md
 */
export abstract class StubCommand extends Command {
  protected abstract readonly phase: number;

  async run(): Promise<void> {
    this.log(
      `not yet implemented — see .prove/decisions/2026-04-21-typescript-cli-unification.md phase ${this.phase}`,
    );
  }
}
