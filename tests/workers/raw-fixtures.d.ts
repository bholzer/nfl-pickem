// Vite's `?raw` suffix inlines a fixture file as a string in the Workers pool,
// which has no file system access.
declare module "*.eml?raw" {
  const content: string;
  export default content;
}
