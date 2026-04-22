import { StubCommand } from '../../stub-command';

export default class RoundTable extends StubCommand {
  static override description = 'Multi-agent deliberation (not yet implemented)';
  protected readonly phase = 8;
}
