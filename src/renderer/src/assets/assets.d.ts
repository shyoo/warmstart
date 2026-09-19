// Vite serves an imported image as its URL.
declare module '*.png' {
  const url: string
  export default url
}
