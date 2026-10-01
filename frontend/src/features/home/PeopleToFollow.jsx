import { useEffect, useState } from "react";
import { SignInButton, useAuth } from "@clerk/react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../../config/api";
import { EmptySignal, SignalPanel } from "./SignalPanels";
import { fetchJson } from "./signals";

// Suggestions exclude the viewer and anyone they already follow, so wait for
// Clerk to settle before asking.
function usePeopleSuggestions() {
    const { getToken, isLoaded, isSignedIn } = useAuth();
    const [people, setPeople] = useState([]);
    const [status, setStatus] = useState("loading");

    useEffect(() => {
        if (!isLoaded) {
            return undefined;
        }

        const controller = new AbortController();

        async function fetchPeople() {
            try {
                const token = isSignedIn ? await getToken() : null;
                const data = await fetchJson("/profile/suggestions?limit=5", { signal: controller.signal, token });
                setPeople(Array.isArray(data.people) ? data.people : []);
                setStatus("ready");
            } catch (error) {
                if (error.name !== "AbortError") {
                    setPeople([]);
                    setStatus("error");
                }
            }
        }

        fetchPeople();

        return () => controller.abort();
    }, [getToken, isLoaded, isSignedIn]);

    return { people, setPeople, status: isLoaded ? status : "loading" };
}

function describeActivity(person) {
    const recent = Number(person.recentReviewCount) || 0;
    const total = Number(person.reviewCount) || 0;

    if (recent) {
        return `${recent} ${recent === 1 ? "review" : "reviews"} this month`;
    }

    return `${total} ${total === 1 ? "review" : "reviews"}`;
}

function FollowButton({ person, onChange }) {
    const { getToken, isSignedIn } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState("");

    if (!isSignedIn) {
        return (
            <SignInButton mode="modal">
                <button type="button" className="signal-queue-action">Follow</button>
            </SignInButton>
        );
    }

    async function toggleFollow() {
        if (isSaving) {
            return;
        }

        setIsSaving(true);
        setError("");

        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/profile/${encodeURIComponent(person.userId)}/follow`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ following: !person.isFollowing }),
            });

            if (!response.ok) {
                throw new Error("Failed to update follow status");
            }

            const data = await response.json();
            onChange({ ...person, isFollowing: Boolean(data.isFollowing) });
        } catch {
            setError("Try again");
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <button
            type="button"
            className={`signal-queue-action${person.isFollowing ? " is-active" : ""}`}
            onClick={toggleFollow}
            disabled={isSaving}
            aria-pressed={person.isFollowing}
            aria-label={`${person.isFollowing ? "Unfollow" : "Follow"} ${person.username}`}
        >
            {error || (person.isFollowing ? "Following" : "Follow")}
        </button>
    );
}

export function PeopleToFollow() {
    const { isSignedIn } = useAuth();
    const { people, setPeople, status } = usePeopleSuggestions();

    function replacePerson(next) {
        setPeople((current) => current.map((person) => (person.userId === next.userId ? next : person)));
    }

    return (
        <SignalPanel id="people-to-follow-title" title="People to follow">
            {people.length ? (
                <ol className="signal-people">
                    {people.map((person) => (
                        <li key={person.userId}>
                            <Link to={`/profile/${person.userId}`} className="signal-person">
                                {person.imageUrl
                                    ? <img src={person.imageUrl} alt="" className="signal-person-avatar" loading="lazy" />
                                    : <span className="signal-person-avatar" aria-hidden="true" />}
                                <span className="signal-rank-copy">
                                    <strong>{person.username}</strong>
                                    <small>{describeActivity(person)}</small>
                                </span>
                            </Link>
                            <FollowButton person={person} onChange={replacePerson} />
                        </li>
                    ))}
                </ol>
            ) : (
                <EmptySignal>
                    {status === "loading"
                        ? "Finding active listeners..."
                        : status === "error"
                            ? "Suggestions are temporarily unavailable."
                            : isSignedIn
                                ? "You already follow everyone who's been reviewing. Check back soon."
                                : "No active reviewers yet."}
                </EmptySignal>
            )}
        </SignalPanel>
    );
}

export default PeopleToFollow;
