import { TextInput } from 'react-native';
import { useFormInput } from '../keyboard';

// A multiline text input for the request form: Return adds a line, and the cursor line stays above the keyboard while it grows. It is its own
// component because the keyboard hook reads the form it sits in, so it has to be rendered below the form (inside RequestFrame).
export function MultilineInput(props) {
  const form = useFormInput({ multiline: true });
  return <TextInput {...form} {...props} />;
}
