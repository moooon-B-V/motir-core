import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';
import { fieldRef, type TranslatableField } from './fieldRefs';

// The five field kinds of a work item, as the translation door and the page-read
// offer both see them (Story MOTIR-7735 · MOTIR-8120). Pure — no I/O.

/** A translatable field with the language its text was recorded in. */
export interface DoorField extends TranslatableField {
  language: string | null;
}

/** Every translatable field of the item, in reading order, with its recorded language. */
export function assembleFields(item: WorkItemDto, todos: readonly WorkItemTodoDto[]): DoorField[] {
  const fields: DoorField[] = [
    { fieldRef: fieldRef.title(), text: item.title, language: item.languages.title },
    {
      fieldRef: fieldRef.description(),
      text: item.descriptionMd ?? '',
      language: item.languages.description,
    },
    {
      fieldRef: fieldRef.explanation(),
      text: item.explanationMd ?? '',
      language: item.languages.explanation,
    },
  ];
  for (const todo of todos) {
    fields.push({
      fieldRef: fieldRef.todoText(todo.id),
      text: todo.text,
      language: todo.textLanguage,
    });
    fields.push({
      fieldRef: fieldRef.todoNotes(todo.id),
      text: todo.notesMd ?? '',
      language: todo.notesLanguage,
    });
  }
  return fields;
}
