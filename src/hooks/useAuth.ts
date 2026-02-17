import { useState, useEffect, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '../firebase';

export interface AuthUser {
  displayName: string | null;
  photoURL: string | null;
  email: string | null;
}

export interface AuthState {
  userId: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const googleProvider = new GoogleAuthProvider();

function useAuthReal(): AuthState {
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUserId(firebaseUser.uid);
        setUser({
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
          email: firebaseUser.email,
        });
      } else {
        setUserId(null);
        setUser(null);
      }
      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    await signInWithPopup(auth, googleProvider);
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
  }, []);

  return { userId, user, isLoading, signInWithGoogle, signOut };
}

// E2E test bypass — return a mock user immediately so Playwright tests
// don't need real Google auth. The env var is set in playwright.config.ts.
// Note: import.meta.env.VITE_E2E_TEST is resolved at build time by Vite,
// so production builds (without the env var) always use useAuthReal.
function useAuthE2E(): AuthState {
  return {
    userId: 'e2e-test-user',
    user: { displayName: 'Test User', photoURL: null, email: 'test@example.com' },
    isLoading: false,
    signInWithGoogle: async () => {},
    signOut: async () => {},
  };
}

export const useAuth = import.meta.env.VITE_E2E_TEST ? useAuthE2E : useAuthReal;
