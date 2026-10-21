import { ErrorScreen } from '../components/ErrorScreen.tsx';

export function Incomplete() {
  return (
    <ErrorScreen title="This link is incomplete">
      The key that opens this tab comes after the # in the link, and this link is missing it. Ask whoever
      shared it to send the link again.
    </ErrorScreen>
  );
}
