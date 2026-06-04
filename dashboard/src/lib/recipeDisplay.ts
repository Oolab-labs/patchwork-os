/**
 * Human-readable recipe display name: dashes/underscores → spaces, each word
 * capitalised (e.g. "morning-brief" → "Morning Brief").
 *
 * Shared so the Overview recipe grid and the FeaturedRecipeAside render the
 * same label (facelift P1-5-A). Routing still uses the raw recipe name —
 * only display text/titles should use this.
 */
export function recipeDisplayName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
