import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'run-state',
    description: 'Orchestrator run state CRUD (not yet implemented)',
    phase: 6,
  });
}
