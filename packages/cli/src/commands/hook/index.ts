import { StubCommand } from '../../stub-command';

export default class Hook extends StubCommand {
  static override description = 'Claude Code hook dispatch (not yet implemented)';
  protected readonly phase = 3;
}
