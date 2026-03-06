import { useEffect, useState } from "react";
import { getToken, clearToken, checkAuth } from "./api";
import { Login } from "./Login";
import { Player } from "./Player";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setAuthed(false);
      return;
    }
    checkAuth()
      .then(() => setAuthed(true))
      .catch(() => {
        clearToken();
        setAuthed(false);
      });
  }, []);

  if (authed === null) return null;

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  return (
    <Player
      onLogout={() => {
        clearToken();
        setAuthed(false);
      }}
    />
  );
}
