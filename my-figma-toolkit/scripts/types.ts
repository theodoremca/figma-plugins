export interface Script {
  id: string;
  name: string;
  description: string;
  run: () => void | Promise<void>;
}
