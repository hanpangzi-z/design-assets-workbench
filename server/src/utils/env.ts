export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} 环境变量必须设置（见 .env.example）`);
  }
  return value;
}
