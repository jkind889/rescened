import { useEffect, useRef } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Show, SignInButton, SignUpButton, useAuth, useClerk } from '@clerk/react';
import {
    buildSuggestionSignInRedirectProps,
    buildSuggestionSignUpRedirectProps,
    getSupportedSuggestionReturnPath,
} from '../features/community/suggestionReturn';

function SuggestionSignInGate({ returnPath, needsCanonicalUrl, suppressAutoOpenRef }) {
    const clerk = useClerk();
    const navigate = useNavigate();

    useEffect(() => {
        if (needsCanonicalUrl) navigate(returnPath, { replace: true });
    }, [navigate, needsCanonicalUrl, returnPath]);

    useEffect(() => {
        // Clerk can read redirect parameters from the URL. Open only after
        // the router has committed the canonical suggestion URL.
        if (needsCanonicalUrl) return;

        // Defer the modal so StrictMode's setup/cleanup probe can cancel it.
        const timer = suppressAutoOpenRef.current ? undefined : setTimeout(() => {
            clerk.openSignIn(buildSuggestionSignInRedirectProps(returnPath));
        }, 0);

        return () => {
            clearTimeout(timer);
            clerk.closeSignIn?.();
            clerk.closeSignUp?.();
        };
    }, [clerk, needsCanonicalUrl, returnPath, suppressAutoOpenRef]);

    if (needsCanonicalUrl) return null;

    return (
        <section className="community-page community-editor-page">
            <div className="community-page-frame community-editor-frame">
                <nav className="community-breadcrumb" aria-label="Suggestions breadcrumb">
                    <Link className="community-back-link" to="/search">← Back to search</Link>
                </nav>
                <div className="suggestion-editor-blocked">
                    <h1 className="suggestion-editor-blocked-title">Sign in to suggest an album</h1>
                    <p className="suggestion-editor-blocked-description">
                        Sign in or create an account to continue your suggestion.
                    </p>
                    <div className="suggestion-sign-in-actions">
                        <SignInButton mode="modal" {...buildSuggestionSignInRedirectProps(returnPath)}>
                            <button type="button" className="community-primary-link">Sign in</button>
                        </SignInButton>
                        <SignUpButton mode="modal" {...buildSuggestionSignUpRedirectProps(returnPath)}>
                            <button type="button" className="community-secondary-button">Sign up</button>
                        </SignUpButton>
                    </div>
                </div>
            </div>
        </section>
    );
}

function SuggestionProtectedRoute({ children }) {
    const { isSignedIn } = useAuth();
    const seenSignedInRef = useRef(false);
    const location = useLocation();
    const returnPath = getSupportedSuggestionReturnPath(location);
    const needsCanonicalUrl = `${location.pathname}${location.search}${location.hash}` !== returnPath;

    useEffect(() => {
        if (isSignedIn) seenSignedInRef.current = true;
    }, [isSignedIn]);

    return (
        <>
            <Show when="signed-in">{children}</Show>
            <Show when="signed-out">
                {returnPath ? (
                    <SuggestionSignInGate
                        returnPath={returnPath}
                        needsCanonicalUrl={needsCanonicalUrl}
                        suppressAutoOpenRef={seenSignedInRef}
                    />
                ) : <Navigate to="/" replace />}
            </Show>
        </>
    );
}

function ProtectedRoute({ children, preserveSuggestionReturn = false }) {
    if (preserveSuggestionReturn) {
        return <SuggestionProtectedRoute>{children}</SuggestionProtectedRoute>;
    }

    return (
        <>
        <Show when="signed-in">
            {children}
        </Show>
        <Show when="signed-out">
            <Navigate to="/" />
        </Show>
        </>
    )
}

export default ProtectedRoute;
