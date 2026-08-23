# Chat UI improvements checklist

- [x] Make response and message action buttons square, with equal heights for text controls.
- [x] Add tactile micro-interactions to chat buttons, composer controls, and related interactive controls.
- [x] Make the right-side conversation preview carousel expand from its right origin toward the chat.
- [x] Reduce vertical padding on user messages.
- [x] Animate newly sent user messages from `scale(0.9)` to `scale(1)`.
- [x] Remove borders from tiered/queued user messages.
- [x] Increase chat UI typography beyond the composer.
- [x] Show user and assistant message sent times on hover in 24-hour format.
- [x] Show the 24-hour sent time on hover beside the copy button without shifting permanent controls.
- [ ] Use `HH:MM` today, `Yesterday` yesterday, and a date for older messages.
- [x] Run focused tests and review the final diff. Frontend typecheck was attempted but is blocked by missing workspace dependencies (`react`/`motion` in `packages/product-ui`).
