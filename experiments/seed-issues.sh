#!/usr/bin/env bash
# seed-issues.sh — Create N realistic issues on a GitHub repo for benchmark testing.
#
# Usage:
#   ./experiments/seed-issues.sh --repo illegalcall/todo-app --count 10
#
# Creates small, well-scoped issues that Claude Code agents can solve in 2-10 minutes.
# Each issue is independent — no dependencies between them.

set -euo pipefail

REPO=""
COUNT=10
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)     REPO="$2"; shift 2 ;;
    --count)    COUNT="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$REPO" ]; then
  echo "Usage: $0 --repo owner/repo [--count N] [--dry-run]" >&2
  exit 1
fi

# Issue definitions — each is a realistic, self-contained task for a todo app.
# Format: TITLE|||BODY
# These build on each other naturally (a todo app needs these features)
# but each can be implemented independently.

ISSUES=(
  "feat: add Todo type definition and sample data|||Create a TypeScript type/interface for Todo items in a new file \`app/types.ts\`:

- \`id\`: string (UUID)
- \`title\`: string
- \`completed\`: boolean
- \`createdAt\`: Date

Also create \`app/data.ts\` with an array of 3-5 sample todos for development use.

Export both the type and the sample data."

  "feat: add TodoItem component|||Create a \`app/components/TodoItem.tsx\` component that renders a single todo item:

- Display the todo title
- Show a checkbox for the completed state
- When checked, apply line-through styling to the title
- Accept \`todo\` and \`onToggle\` props
- Use Tailwind CSS for styling
- Add proper TypeScript types for props

The component should be a client component since it handles user interaction."

  "feat: add TodoList component|||Create a \`app/components/TodoList.tsx\` component that renders a list of todo items:

- Accept a \`todos\` array prop and \`onToggle\` callback
- Render each todo using a TodoItem component
- Show a message when the list is empty: \"No todos yet. Add one above!\"
- Use a simple \`ul\` with \`li\` wrappers
- Use Tailwind CSS for styling and spacing"

  "feat: add AddTodo form component|||Create a \`app/components/AddTodo.tsx\` client component with a form to add new todos:

- Text input for the todo title
- Submit button labeled \"Add\"
- Clear the input after submission
- Don't allow empty submissions (disable button when input is empty)
- Accept an \`onAdd\` callback prop that receives the title string
- Use Tailwind CSS — input with border, rounded button with blue background
- Handle both button click and Enter key submission"

  "feat: wire up main page with state management|||Update \`app/page.tsx\` to be a client component that:

- Imports and uses the TodoList and AddTodo components
- Manages todos state with \`useState\`, initialized with sample data from \`data.ts\`
- Implements \`handleAdd\` — creates a new todo with a unique id (crypto.randomUUID())
- Implements \`handleToggle\` — toggles the completed state of a todo by id
- Renders AddTodo above TodoList
- Update the page title to \"Todo App\""

  "feat: add todo deletion|||Add the ability to delete todos:

- Add a delete button (red \"X\" or trash icon) to each TodoItem
- Add an \`onDelete\` callback prop to TodoItem and TodoList
- Implement \`handleDelete\` in page.tsx that removes a todo by id
- Confirm before deleting (use \`window.confirm\`)
- Style the delete button to appear on hover"

  "feat: add todo count summary|||Add a summary bar below the heading on the main page showing:

- Total number of todos
- Number of completed todos
- Number of remaining todos
- Example: \"3 todos — 1 done, 2 remaining\"
- Use muted/gray text styling
- Update dynamically as todos are added, toggled, or deleted"

  "feat: add filter tabs for todo list|||Add filter functionality to the todo list:

- Three filter buttons/tabs: \"All\", \"Active\", \"Completed\"
- Highlight the active filter tab
- Filter the displayed todos based on selection
- Store the active filter in component state
- Place the filter tabs between the AddTodo form and the TodoList
- Use Tailwind CSS for tab styling (border-bottom or background highlight for active tab)"

  "feat: add localStorage persistence|||Persist todos to localStorage so they survive page refreshes:

- Save todos to localStorage whenever the todos array changes (use \`useEffect\`)
- Load todos from localStorage on initial render (lazy initializer in useState)
- Use the key \"todos\" in localStorage
- Handle the case where localStorage data is corrupted (fall back to sample data)
- Ensure dates are properly serialized/deserialized (JSON doesn't preserve Date objects)"

  "feat: add due date field to todos|||Extend the todo system with due dates:

- Add an optional \`dueDate: string | null\` field to the Todo type
- Add a date input to the AddTodo form
- Display the due date in TodoItem (format: \"Due: Jan 15, 2026\")
- Highlight overdue todos in red (due date is in the past and todo is not completed)
- Allow creating todos without a due date"

  "feat: add edit-in-place for todo titles|||Allow users to edit todo titles inline:

- Double-click on a todo title to enter edit mode
- Show a text input pre-filled with the current title
- Save on Enter or blur, cancel on Escape
- Don't allow saving an empty title
- Add an \`onEdit\` callback prop to TodoItem
- Implement the handler in page.tsx to update the todo's title"

  "feat: add priority levels to todos|||Add priority support to todos:

- Add a \`priority: 'low' | 'medium' | 'high'\` field to the Todo type (default: 'medium')
- Add a priority selector (dropdown or radio buttons) to AddTodo form
- Display priority in TodoItem with color coding: high=red, medium=yellow, low=green
- Show priority as a small colored dot or badge next to the title
- Update the Todo type and sample data"

  "feat: add keyboard shortcuts|||Add keyboard shortcuts for common actions:

- \`n\` — focus the new todo input
- \`Escape\` — blur/unfocus the current input
- \`1/2/3\` — switch between All/Active/Completed filters (if filter tabs exist, otherwise skip)
- Add a small \"Keyboard shortcuts\" help text or \"?\" button that shows available shortcuts
- Use \`useEffect\` with \`keydown\` event listener
- Don't trigger shortcuts when user is typing in an input field"

  "feat: add dark mode toggle|||Add a dark mode toggle to the app:

- Add a toggle button in the top-right corner (sun/moon icon or text)
- Store the preference in localStorage
- Apply dark mode using Tailwind's dark: variants
- Add \`dark\` class to the \`html\` element when enabled
- Default to system preference using \`prefers-color-scheme\` media query
- Ensure all existing components look good in both modes"

  "feat: add drag-and-drop reordering|||Add the ability to reorder todos by dragging:

- Implement drag and drop using the native HTML5 Drag and Drop API (no external libraries)
- Add a drag handle (≡ icon or grab cursor) to each TodoItem
- Visual feedback during drag (opacity change, placeholder)
- Update the todos array order when dropped
- Persist the new order (if localStorage is implemented)"

  "refactor: extract custom hooks|||Refactor the main page to use custom hooks for cleaner code:

- Create \`app/hooks/useTodos.ts\` — encapsulates all todo CRUD operations (add, toggle, delete, edit) and state
- Create \`app/hooks/useFilter.ts\` — encapsulates filter state and filtered todos logic
- Create \`app/hooks/useLocalStorage.ts\` — generic hook for localStorage-backed state
- Move the logic from page.tsx into these hooks
- page.tsx should become a thin component that just composes hooks and renders components"

  "fix: update page metadata and favicon|||Update the app metadata:

- Change the page title from \"Create Next App\" to \"Todo App\" in layout.tsx
- Update the description to something meaningful
- Add a simple todo-list emoji (✓) as the favicon (create a simple SVG favicon)
- Add an Open Graph title and description for link previews"

  "feat: add bulk actions toolbar|||Add a toolbar for bulk operations on todos:

- \"Select All\" / \"Deselect All\" checkbox
- \"Delete Completed\" button — removes all completed todos
- \"Mark All Complete\" / \"Mark All Incomplete\" toggle
- Only show the toolbar when there are todos
- Disable buttons that don't apply (e.g., \"Delete Completed\" when none are completed)
- Use Tailwind CSS for a clean toolbar layout"

  "feat: add search/filter by text|||Add a search input that filters todos by title:

- Add a search input above the todo list
- Filter todos in real-time as the user types
- Case-insensitive matching
- Show \"No todos match your search\" when filter has no results
- Add a clear button (X) to reset the search
- Combine with existing filter tabs if they exist (search within the active filter)"

  "feat: add todo categories/tags|||Add category/tag support:

- Add a \`category: string\` field to the Todo type (e.g., \"work\", \"personal\", \"shopping\")
- Add a category selector to the AddTodo form (text input or predefined dropdown)
- Display categories as colored badges on TodoItem
- Add category filter buttons (in addition to All/Active/Completed)
- Auto-suggest categories based on previously used ones"
)

echo "[seed-issues] Creating $COUNT issues on $REPO..."

CREATED=0
for i in $(seq 0 $((COUNT - 1))); do
  if [ "$i" -ge "${#ISSUES[@]}" ]; then
    echo "[seed-issues] Only ${#ISSUES[@]} issue templates available, created $CREATED."
    break
  fi

  IFS='|||' read -r TITLE BODY <<< "${ISSUES[$i]}"

  if [ "$DRY_RUN" = true ]; then
    echo "[seed-issues] [DRY RUN] Would create: $TITLE"
  else
    echo "[seed-issues] Creating issue $((i + 1))/$COUNT: $TITLE"
    gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" --label "benchmark" 2>/dev/null \
      || gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" 2>/dev/null
    CREATED=$((CREATED + 1))
    # Small delay to avoid secondary rate limits
    sleep 1
  fi
done

echo "[seed-issues] Done. Created $CREATED issues on $REPO."
echo "[seed-issues] View: https://github.com/$REPO/issues"
