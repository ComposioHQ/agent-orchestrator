# Agent Switch Shaft Animation Design

## Goal

Make the agent-switch transfer graphic read as one connected arrow whose motion travels from the source agent to the destination agent without animating or illuminating the arrowhead.

## Design

- Keep a single connected visual arrow between the provider marks.
- Render the shaft and arrowhead as separate SVG geometry so their motion behavior cannot overlap accidentally.
- Keep the shaft's existing left-to-right gradient pulse.
- Clip the pulse at the base of the arrowhead.
- Keep the arrowhead static at all times.
- Under reduced-motion preferences, show a stationary highlight on the shaft only.

## Scope

This change affects only the switching-in-progress transfer graphic and its focused renderer test. It does not change the switch lifecycle, timing, provider marks, progress steps, dialog, or backend behavior.

## Verification

- Assert that the transfer graphic has separate shaft and arrowhead geometry.
- Assert that the animated pulse is nested only inside the shaft region.
- Run the focused `CenterPane` renderer test and frontend typecheck.
