import { StubCommand } from '../../stub-command';

export default class Store extends StubCommand {
  static override description = 'Unified prove.db store operations (not yet implemented)';
  protected readonly phase = 3;
}
