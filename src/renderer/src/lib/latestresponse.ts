/** Keep an older RPC response from replacing state fetched after a newer event. */
export class LatestResponse {
  private generation = 0

  async apply<T>(
    request: Promise<T>,
    update: (value: T) => void,
    onError?: (error: unknown) => void
  ): Promise<void> {
    const generation = ++this.generation
    try {
      const value = await request
      if (generation === this.generation) update(value)
    } catch (error) {
      if (generation === this.generation) onError?.(error)
    }
  }
}
