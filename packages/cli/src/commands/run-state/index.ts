import { StubCommand } from '../../stub-command';

export default class RunState extends StubCommand {
  static override description = 'Orchestrator run state CRUD (not yet implemented)';
  protected readonly phase = 6;
}
