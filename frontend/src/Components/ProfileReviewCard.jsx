import LikeButton from "./LikeButton";
import ShareButton from "./ShareButton";
import CommentCountLink from "../features/comments/CommentCountLink";
import Cover from "./Cover";
import EditedTag from "../features/reviews/EditedTag";
import { CardLink, CardTitleLink } from "./CardLink";
import ArtistCredits from "../features/artists/ArtistCredits";

function formatDate(value) {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function AlbumCover({ src, title }) {
  if (!src) {
    return <div className="profile-cover-fallback">No cover</div>;
  }

  return <Cover className="profile-cover" src={src} alt={`${title} cover`} />;
}

export function ProfileReviewCard({ review, likeMessage = "", onToggleLike }) {
  return (
    <article className="profile-review-card">
      <CardLink className="profile-review-album">
        <AlbumCover src={review.album?.cover} title={review.album?.title} />
        <div>
          <h3><CardTitleLink to={`/album/${review.albumId}`}>{review.album?.title || "Untitled album"}</CardTitleLink></h3>
          <p><ArtistCredits album={review.album} fallback="Artist unknown" /></p>
        </div>
      </CardLink>
      <div className="profile-review-meta">
        <span>{review.rating}/5</span>
        <time>{formatDate(review.date)}</time>
        <EditedTag editedAt={review.editedAt} />
      </div>
      <p className="profile-review-copy">{review.reviewText}</p>
      <div className="review-card-actions">
        <LikeButton
          liked={Boolean(review.likedByViewer)}
          count={review.likeCount}
          label="review"
          message={likeMessage}
          onToggle={onToggleLike ? () => onToggleLike(review) : undefined}
        />
        <CommentCountLink reviewId={review.reviewId} count={review.commentCount} />
        {review.reviewId && <ShareButton className="review-share-button" path={`/review/${review.reviewId}`} title={`Review of ${review.album?.title || "an album"} on Rescened`} />}
      </div>
    </article>
  );
}

export default ProfileReviewCard;
