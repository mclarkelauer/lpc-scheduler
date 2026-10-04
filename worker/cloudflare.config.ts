// Deployment configuration for the cf CLI (`cf deploy`).
// wrangler.jsonc holds the same settings for local runs with `npx wrangler dev`; keep the two in step.
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "lpc-scheduler-picks",
		compatibilityDate: "2026-09-01",
		entrypoint: "src/index.js",
		env: {
			// The published schedule page. The calendar feed reads session times, rooms and abstracts from it.
			SCHEDULE_URL: bindings.text("https://mclarkelauer.github.io/lpc-scheduler/"),
			DB: bindings.d1({
				name: "lpc-scheduler-picks",
				id: "8c52fc96-e329-4238-8b76-176cb75f4fac",
			}),
		},
	},
});
