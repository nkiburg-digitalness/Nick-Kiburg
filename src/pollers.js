import { CHANNEL_LABELS } from './inventory.js';

/**
 * Runs channel.poll(inventory) on an interval, never overlapping, and records the
 * outcome so the dashboard can show when each channel was last checked.
 */
export class Poller {
  constructor({ channel, inventory, bus, intervalSeconds }) {
    this.channel = channel;
    this.inventory = inventory;
    this.bus = bus;
    this.intervalMs = intervalSeconds * 1000;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = null;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.run(), this.intervalMs);
    this.timer.unref?.();
    setTimeout(() => this.run(), 1000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const label = CHANNEL_LABELS[this.channel.name] ?? this.channel.name;
    try {
      const booked = await this.channel.poll(this.inventory);
      this.lastRunAt = new Date().toISOString();
      if (this.lastError) this.bus.log('info', `${label} weer bereikbaar`, { channel: this.channel.name });
      this.lastError = null;
      if (booked) this.bus.log('info', `${label}: ${booked} orderregel(s) verwerkt`, { channel: this.channel.name });
    } catch (err) {
      if (err.message !== this.lastError) {
        this.bus.log('error', `${label} orders ophalen mislukt: ${err.message}`, { channel: this.channel.name });
      }
      this.lastError = err.message;
    } finally {
      this.running = false;
      this.bus.publish('poll', this.status());
    }
  }

  status() {
    return { channel: this.channel.name, lastRunAt: this.lastRunAt, lastError: this.lastError };
  }
}
