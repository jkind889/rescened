import { useEffect, useState } from "react";
import { useAuth, useUser } from "@clerk/react";
import { Link } from "react-router-dom";
import {
    ArrowIcon,
    DispatchList,
    EmptySignal,
    Masthead,
    RankedAlbumList,
    ReviewQueue,
    SignalPanel,
} from "../features/home/SignalPanels";
import { ListeningLog } from "../features/home/ListeningLog";
import { fetchJson, settledArray, uniqueAlbums } from "../features/home/signals";
import "../features/home/home.css";

const EMPTY_CIRCLE = { popular: [], reviews: [], listens: [], unreviewed: [] };

// Circle feeds cover the signed-in viewer and every account they follow.
function useCircleSignals(isSignedIn) {
    const { getToken } = useAuth();
    const [signals, setSignals] = useState(EMPTY_CIRCLE);
    const [status, setStatus] = useState("idle");

    useEffect(() => {
        if (!isSignedIn) {
            return undefined;
        }

        const controller = new AbortController();

        async function fetchSignals() {
            setStatus("loading");

            try {
                const token = await getToken();
                const options = { signal: controller.signal, token };
                const results = await Promise.allSettled([
                    fetchJson("/reviews/circle/popular?limit=5&window=30d", options),
                    fetchJson("/reviews/circle/popular-reviews?limit=3", options),
                    fetchJson("/diary?limit=10", options),
                    fetchJson("/diary/unreviewed?limit=4", options),
                ]);

                if (controller.signal.aborted) {
                    return;
                }

                const [popular, reviews, listens, unreviewed] = results;
                setSignals({
                    popular: settledArray(popular),
                    reviews: settledArray(reviews),
                    listens: settledArray(listens, "listens"),
                    unreviewed: settledArray(unreviewed, "albums"),
                });
                setStatus(results.some((result) => result.status === "fulfilled") ? "ready" : "error");
            } catch (error) {
                if (error.name !== "AbortError") {
                    setSignals(EMPTY_CIRCLE);
                    setStatus("error");
                }
            }
        }

        fetchSignals();

        return () => controller.abort();
    }, [getToken, isSignedIn]);

    return isSignedIn ? { signals, status } : { signals: EMPTY_CIRCLE, status: "idle" };
}

export function FrontPage() {
    const { isLoaded, isSignedIn } = useUser();
    const { signals, status } = useCircleSignals(isLoaded && isSignedIn);
    const isLoading = !isLoaded || status === "loading";
    const reference = uniqueAlbums([
        ...signals.popular,
        ...signals.reviews,
        ...signals.listens,
    ]).length;

    return (
        <div className="home-page home-page-open">
            <div className="home-rail">
                <Masthead edition="Circle Signals" reference={reference} />
                <ListeningLog listens={signals.listens} isSignedIn={isSignedIn} isLoading={isLoading} />
            </div>

            <div className="home-feed">
                {status === "error" && (
                    <EmptySignal>Your circle feed is temporarily unavailable.</EmptySignal>
                )}

                <SignalPanel id="circle-popular-title" title="Popular in your circle">
                    {signals.popular.length ? (
                        <RankedAlbumList albums={signals.popular} />
                    ) : (
                        <EmptySignal>
                            {isLoading
                                ? "Calculating your circle's month..."
                                : isSignedIn
                                    ? "No reviews from your circle this month. Follow listeners or review an album to fill it in."
                                    : "Sign in to rank what your circle reviewed this month."}
                        </EmptySignal>
                    )}
                </SignalPanel>

                <SignalPanel id="circle-dispatches-title" title="Circle dispatches">
                    {signals.reviews.length ? (
                        <DispatchList reviews={signals.reviews} />
                    ) : (
                        <EmptySignal>
                            {isLoading
                                ? "Gathering dispatches..."
                                : isSignedIn
                                    ? "No reviews from your circle yet."
                                    : "Reviews from people you follow will appear here."}
                        </EmptySignal>
                    )}
                </SignalPanel>

                {isSignedIn && (
                    <SignalPanel id="review-queue-title" title="Waiting for your review">
                        {signals.unreviewed.length ? (
                            <ReviewQueue albums={signals.unreviewed} />
                        ) : (
                            <EmptySignal>
                                {isLoading ? "Checking your diary..." : "Every album you've logged has a review."}
                            </EmptySignal>
                        )}
                    </SignalPanel>
                )}

                <Link to="/community" className="home-community-link">
                    See what the whole community is playing <ArrowIcon />
                </Link>
            </div>

        </div>
    );
}

export default FrontPage;
