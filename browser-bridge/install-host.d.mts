export const NATIVE_HOST_ID: string;

export interface NativeHostTargetOptions {
  platform?: string;
  home?: string;
  configHome?: string;
  localAppData?: string;
  dataRoot?: string;
  hostScript?: string;
  nodePath?: string;
  extensionOrigin?: string;
  geckoExtensionId?: string;
  dryRun?: boolean;
  uninstall?: boolean;
}

export function nativeHostTargets(options?: NativeHostTargetOptions): {
  launcherPath: string;
  manifests: { kind: "chromium" | "firefox"; file: string }[];
  registryKeys: { kind: "chromium" | "firefox"; key: string }[];
};

export function installNativeHost(options?: NativeHostTargetOptions): Promise<{
  action: "install" | "uninstall";
  dryRun: boolean;
  launcherPath: string;
  files: string[];
  registryKeys: string[];
  manifests?: {
    chromium: { name: string; path: string; allowed_origins: string[] };
    firefox: { name: string; path: string; allowed_extensions: string[] };
  };
}>;
