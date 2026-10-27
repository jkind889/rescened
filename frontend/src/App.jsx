import { lazy } from "react";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import "./reset.css";
import "./App.css";
import FrontPage from "./Pages/FrontPage";
import Layout from "./Layout";
import ProtectedRoute from "./Components/ProtectedRoute";

// FrontPage stays in the entry chunk; every other route loads on demand.
const SearchResults = lazy(() => import("./Pages/SearchResults"));
const AlbumDetail = lazy(() => import("./Components/AlbumDetail"));
const ViewReviews = lazy(() => import("./Pages/ViewReviews"));
const ReviewDispatches = lazy(() => import("./Pages/ReviewDispatches"));
const PopularAlbums = lazy(() => import("./Pages/PopularAlbums"));
const Account = lazy(() => import("./Pages/Account"));
const EditProfile = lazy(() => import("./Pages/EditProfile"));
const LastfmCallback = lazy(() => import("./Pages/LastfmCallback"));
const AlbumMappings = lazy(() => import("./Pages/AlbumMappings"));
const ProfileNetwork = lazy(() => import("./Pages/ProfileNetwork"));
const Boards = lazy(() => import("./Pages/Boards"));
const BoardDetail = lazy(() => import("./Pages/BoardDetail"));
const Notifications = lazy(() => import("./Pages/Notifications"));
const PatchNotes = lazy(() => import("./Pages/PatchNotes"));
const Community = lazy(() => import("./Pages/Community"));
const ReviewPermalink = lazy(() => import("./Pages/ReviewPermalink"));
const Suggestions = lazy(() => import("./Pages/Suggestions"));
const SuggestionEditor = lazy(() => import("./Pages/SuggestionEditor"));
const ApprovedSuggestions = lazy(() => import("./Pages/ApprovedSuggestions"));
const ModerationSuggestions = lazy(() => import("./Pages/ModerationSuggestions"));
const AlbumBaselines = lazy(() => import("./Pages/AlbumBaselines"));
const GenreVocabulary = lazy(() => import("./Pages/GenreVocabulary"));
const CommentReports = lazy(() => import("./Pages/CommentReports"));
const GenrePage = lazy(() => import("./Pages/GenrePage"));

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<FrontPage />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/boards" element={<Boards />} />
            <Route path="/boards/:boardId" element={<BoardDetail />} />
            <Route
              path="/collection"
              element={<Navigate to="/account" state={{ activeTab: "saved" }} replace />}
            />
            <Route path="/album/:albumId" element={<AlbumDetail />} />
            <Route path="/album/:albumId/reviews" element={<AlbumDetail />} />
            <Route path="/review/:reviewId" element={<ReviewPermalink />} />
            <Route path="/genre/:slug" element={<GenrePage />} />
            <Route path="/viewreviews" element={
            <ProtectedRoute>
              <ViewReviews />
            </ProtectedRoute>} />
            <Route path="/review-dispatches" element={<ReviewDispatches />} />
            <Route path="/popular-albums" element={<PopularAlbums />} />
            <Route path="/community" element={<Community />} />
            <Route path="/community/approved" element={<ApprovedSuggestions />} />
            <Route path="/patch-notes" element={<PatchNotes />} />
            <Route path="/account" element={<Account />} />
            <Route path="/account/network" element={<ProfileNetwork />} />
            <Route path="/notifications" element={
              <ProtectedRoute>
                <Notifications />
              </ProtectedRoute>} />
            <Route path="/suggestions" element={
              <ProtectedRoute>
                <Suggestions />
              </ProtectedRoute>} />
            <Route path="/suggestions/new" element={
              <ProtectedRoute>
                <SuggestionEditor />
              </ProtectedRoute>} />
            <Route path="/suggestions/corrections/:albumId" element={
              <ProtectedRoute>
                <SuggestionEditor mode="correction" />
              </ProtectedRoute>} />
            <Route path="/suggestions/genres/:albumId" element={
              <ProtectedRoute>
                <SuggestionEditor mode="genres" />
              </ProtectedRoute>} />
            <Route path="/suggestions/:submissionId/revise" element={
              <ProtectedRoute>
                <SuggestionEditor mode="revise" />
              </ProtectedRoute>} />
            <Route path="/suggestions/:submissionId" element={
              <ProtectedRoute>
                <Suggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/album-suggestions" element={
              <ProtectedRoute>
                <ModerationSuggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/album-suggestions/:submissionId" element={
              <ProtectedRoute>
                <ModerationSuggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/genres" element={
              <ProtectedRoute>
                <GenreVocabulary />
              </ProtectedRoute>} />
            <Route path="/moderation/genres/:genreId" element={
              <ProtectedRoute>
                <GenreVocabulary />
              </ProtectedRoute>} />
            <Route path="/moderation/comment-reports" element={
              <ProtectedRoute>
                <CommentReports />
              </ProtectedRoute>} />
            <Route path="/moderation/album-mappings" element={
              <ProtectedRoute>
                <AlbumMappings />
              </ProtectedRoute>} />
            <Route path="/moderation/album-mappings/:caseId" element={
              <ProtectedRoute>
                <AlbumMappings />
              </ProtectedRoute>} />
            <Route path="/moderation/album-baselines" element={
              <ProtectedRoute>
                <AlbumBaselines />
              </ProtectedRoute>} />
            <Route path="/moderation/album-baselines/:albumId" element={
              <ProtectedRoute>
                <AlbumBaselines />
              </ProtectedRoute>} />
            <Route path="/profile/:userId/reviews" element={<ViewReviews />} />
            <Route path="/profile/:userId/network" element={<ProfileNetwork />} />
            <Route path="/profile/:userId/boards/:boardId" element={<BoardDetail />} />
            <Route path="/profile/:userId" element={<Account />} />
            <Route path="/account/edit" element={
              <ProtectedRoute>
                <EditProfile />
              </ProtectedRoute>} />
            <Route path="/account/lastfm/callback" element={<LastfmCallback />} />
          </Route>
        </Routes>
      </div>
    </BrowserRouter>
  );


}

export default App
