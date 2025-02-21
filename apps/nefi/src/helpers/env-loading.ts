import { access, readFile, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import { intro, text, log, outro, isCancel } from '@clack/prompts';
import pc from 'picocolors';

const SHELL = process.env.SHELL || '/bin/bash';
const SHELL_NAME = SHELL.split('/').pop() || 'bash';

interface EnvLoadingOptions {
  requiredEnvVars: string[];
  cwd?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(path, 'utf-8');
    return content
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .reduce((acc, line) => {
        const [key, ...values] = line.split('=');
        if (key) {
          acc[key.trim()] = values.join('=').trim().replace(/^["']|["']$/g, '');
        }
        return acc;
      }, {} as Record<string, string>);
  } catch {
    return {};
  }
}

async function promptForEnvVar(varName: string): Promise<string> {
  const value = await text({
    message: `Enter value for ${pc.dim(varName)}`,
    placeholder: 'Your secret key',
    validate: (value) => {
      if (!value) return 'Please enter a value';
    }
  });

  if (value === null) {
    process.exit(1);
  }

  if (isCancel(value)) {
    outro("Environment setup cancelled");
    process.exit(1);
  }

  return value as string;
}

export async function appendToEnvFile(path: string, key: string, value: string): Promise<void> {
  const content = `\n${key}=${value}\n`;
  try {
    if (await fileExists(path)) {
      await appendFile(path, content);
    } else {
      await writeFile(path, content);
    }
  } catch (error) {
    log.error(`Failed to write to ${path}`);
    throw error;
  }
}

export async function loadEnvVars({ requiredEnvVars, cwd = process.cwd() }: EnvLoadingOptions): Promise<void> {
// TODO: make it minimal if env vars exists
  // intro('Environment Variables Setup');
  
  const envPath = join(cwd, '.env');
  const envLocalPath = join(cwd, '.env.local');
  
  const envFileVars = await readEnvFile(envPath);
  const envLocalVars = await readEnvFile(envLocalPath);
  
  for (const varName of requiredEnvVars) {
    // Check process.env first (includes shell vars)
    if (process.env[varName]) {
      // log.success(`Found ${pc.dim(varName)} in environment`);
      continue;
    }
    
    // Check .env and .env.local files
    if (envFileVars[varName]) {
      process.env[varName] = envFileVars[varName];
      // log.success(`Loaded ${pc.dim(varName)} from ${pc.dim('.env')} file`);
      continue;
    }
    
    if (envLocalVars[varName]) {
      process.env[varName] = envLocalVars[varName];
      // log.success(`Loaded ${pc.dim(varName)} from ${pc.dim('.env.local')} file`);
      continue;
    }
    
    // If not found anywhere, prompt for input
    intro(`${pc.dim(varName)} not found in environment or config files`);
    log.info(`You can:
  1. Set it in your ${pc.dim(SHELL_NAME)} shell: ${pc.dim(`export ${varName}=value`)}
  2. Add it to ${pc.dim('.env')} or ${pc.dim('.env.local')} file manually
  3. Enter value now (will be saved to ${pc.dim('.env.local')})`);
    
    const value = await promptForEnvVar(varName);
    process.env[varName] = value;
    
    await appendToEnvFile(envLocalPath, varName, value);
    log.success(`Added ${pc.dim(varName)} to ${pc.dim('.env.local')}`);
  }

} 
