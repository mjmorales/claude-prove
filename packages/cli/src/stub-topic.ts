import type { CAC } from 'cac';

/**
 * Declarative record for a placeholder topic. Each topic in the current
 * cli skeleton resolves to a single stub action that prints a
 * phase-tagged "not yet implemented" notice. Real logic replaces the
 * stub when that phase ports.
 */
export interface StubTopic {
  name: string;
  description: string;
  phase: number;
}

/**
 * Attach a stub command to the given cac instance. The action prints
 * a one-line notice and exits 0 so that operators invoking the topic
 * get a clear, phase-tagged "not yet implemented" signal.
 */
export function registerStubTopic(cli: CAC, topic: StubTopic): void {
  cli.command(topic.name, topic.description).action(() => {
    console.log(`not yet implemented (phase ${topic.phase})`);
  });
}
