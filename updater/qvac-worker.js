import { initializeWorker, ensureRPCSetup } from '@qvac/sdk/worker-lifecycle';
import { getServerLogger } from '@qvac/sdk/logging';
import { registerPlugins } from '@qvac/inference/plugins';
import { whisperPlugin } from '@qvac/inference/whispercpp-transcription/plugin';

const { hasRPCConfig } = initializeWorker();
const logger = getServerLogger();
logger.info('🐻 Hello from Smart Subtitle QVAC Worker');

const pluginsToRegister = [whisperPlugin];

try {
  const { llmPlugin } = await import('@qvac/inference/llamacpp-completion/plugin');
  if (llmPlugin) {
    pluginsToRegister.push(llmPlugin);
  }
} catch (e) {
  logger.debug('llmPlugin not available yet:', e?.message || e);
}

registerPlugins(pluginsToRegister);

if (hasRPCConfig) {
  ensureRPCSetup();
}

