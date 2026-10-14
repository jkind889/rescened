// Review list orders the API accepts, with their control and heading copy.
export const REVIEW_SORTS = {
    recent: { label: "Latest first", heading: "Latest Reviews" },
    popular: { label: "Most liked", heading: "Most Liked Reviews" },
    highest: { label: "Highest rated", heading: "Highest Rated Reviews" },
    lowest: { label: "Lowest rated", heading: "Lowest Rated Reviews" },
};

export const REVIEW_SORT_OPTIONS = Object.entries(REVIEW_SORTS).map(([value, sort]) => ({ value, label: sort.label }));
