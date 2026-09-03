import { ChannelAdapter } from "./adapters/channel-adapter.interface";
import { WhatsAppAdapter } from "./adapters/whatsapp.adapter";
import { TelegramAdapter } from "./adapters/telegram.adapter";

// Instagram and Facebook adapters land here next (see IMPLEMENTATION_TRACKER.md).
// Registering a new channel is just adding one line here — nothing else in
// the app needs to know it exists.
const adapters: Record<string, ChannelAdapter> = {
  whatsapp: new WhatsAppAdapter(),
  telegram: new TelegramAdapter(),
};

export function getAdapter(type: string): ChannelAdapter {
  const adapter = adapters[type];
  if (!adapter) throw new Error(`No channel adapter registered for type "${type}"`);
  return adapter;
}
