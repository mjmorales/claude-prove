import type { CAC } from 'cac';
import { registerStubTopic } from '../stub-topic';

export function register(cli: CAC): void {
  registerStubTopic(cli, {
    name: 'scrum',
    description: 'Agentic task management (not yet implemented)',
    phase: 12,
  });
}
