export interface OpencodeIntegrationRegistration {
  command: string;
  description: string;
}

export interface OpencodeIntegrationEntry {
  name: string;
  version: string;
  commands: OpencodeIntegrationRegistration[];
}

export interface OpencodeRuntime {
  registerCommand: (registration: OpencodeIntegrationRegistration) => void;
}
