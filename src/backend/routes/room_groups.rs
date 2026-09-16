use super::super::{
    dto::{
        CreateRoomGroupRequest, SetGroupCollapsedRequest, SetGroupRoomsRequest,
        SetSidebarOrderRequest, UpdateRoomGroupRequest,
    },
    helpers::{error_response, extract_token, generate_id, get_user_from_token},
    state::{AppState, RoomGroupEntry, UserRoomGroupsRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use mongodb::options::ReplaceOptions;
use serde_json::{json, Value};
use std::sync::Arc;

/// Helper: load the user's room groups document (or create a default empty one).
async fn load_groups(state: &AppState, user_id: &str) -> UserRoomGroupsRecord {
    let coll = state.db.collection::<UserRoomGroupsRecord>("room_groups");
    match coll.find_one(doc! { "_id": user_id }).await {
        Ok(Some(rec)) => rec,
        _ => UserRoomGroupsRecord {
            user_id: user_id.to_string(),
            groups: Vec::new(),
            order: Vec::new(),
        },
    }
}

/// Helper: save (upsert) the user's room groups document.
async fn save_groups(
    state: &AppState,
    rec: &UserRoomGroupsRecord,
) -> Result<(), (StatusCode, Json<Value>)> {
    let coll = state.db.collection::<UserRoomGroupsRecord>("room_groups");
    coll.replace_one(doc! { "_id": &rec.user_id }, rec)
        .with_options(ReplaceOptions::builder().upsert(true).build())
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database error"))?;
    Ok(())
}

/// GET /api/room-groups
pub(crate) async fn get_room_groups(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rec = load_groups(&state, &user_id).await;
    let groups: Vec<Value> = rec
        .groups
        .iter()
        .map(|g| {
            json!({
                "group_id": g.group_id,
                "name": g.name,
                "position": g.position,
                "collapsed": g.collapsed,
                "room_ids": g.room_ids,
            })
        })
        .collect();
    Ok(Json(json!({ "groups": groups, "order": rec.order })))
}

/// POST /api/room-groups
pub(crate) async fn create_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateRoomGroupRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Group name cannot be empty",
        ));
    }

    let mut rec = load_groups(&state, &user_id).await;
    let position = rec.groups.len() as i32;
    let group_id = generate_id("g");
    rec.groups.push(RoomGroupEntry {
        group_id: group_id.clone(),
        name,
        position,
        collapsed: false,
        room_ids: Vec::new(),
    });
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "group_id": group_id })))
}

/// PUT /api/room-groups/{group_id}
pub(crate) async fn update_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<UpdateRoomGroupRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    let group = rec
        .groups
        .iter_mut()
        .find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;

    if let Some(name) = body.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                "Group name cannot be empty",
            ));
        }
        group.name = name;
    }
    if let Some(pos) = body.position {
        group.position = pos;
    }
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/room-groups/{group_id}
pub(crate) async fn delete_room_group(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    // Read before the group goes: its rooms are about to become top-level
    // ones, and where they belong is where the folder was.
    let freed = rec
        .groups
        .iter()
        .find(|g| g.group_id == group_id)
        .map(|g| g.room_ids.clone())
        .unwrap_or_default();
    let before_len = rec.groups.len();
    rec.groups.retain(|g| g.group_id != group_id);
    if rec.groups.len() == before_len {
        return Err(error_response(StatusCode::NOT_FOUND, "Group not found"));
    }
    // Its rooms take its place in the order rather than falling to the end of
    // the rail, which is where an untracked id goes.
    match rec.order.iter().position(|id| id == &group_id) {
        Some(at) => {
            rec.order.splice(at..=at, freed);
        }
        None => rec.order.extend(freed),
    }
    rec.order.retain(|id| id != &group_id);
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/room-groups/{group_id}/rooms
pub(crate) async fn set_group_rooms(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<SetGroupRoomsRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;

    // Remove these room_ids from all other groups first (a room can only be in one group)
    let new_ids_set: std::collections::HashSet<&str> =
        body.room_ids.iter().map(|s| s.as_str()).collect();
    for g in rec.groups.iter_mut() {
        if g.group_id != group_id {
            g.room_ids.retain(|rid| !new_ids_set.contains(rid.as_str()));
        }
    }

    let group = rec
        .groups
        .iter_mut()
        .find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;
    group.room_ids = body.room_ids;
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Clean an order the client sent, and renumber the groups to agree with it.
///
/// Two things can only be decided here. An order is a list of ids the client
/// composed from what it was showing, so it can carry an id twice (a drag
/// that crossed itself) or an id for something since deleted — kept, it would
/// draw a room in two places at once, or hold a gap for a folder that is
/// gone. And `position` on a group predates this list: anything still reading
/// it has to see the same arrangement, so the list is what sets it rather
/// than a second opinion about the same thing.
///
/// Ids belonging to neither a group nor a room this user is in are kept: the
/// alternative is to resolve every room membership here to prove a negative,
/// and an id for something the user cannot see draws nothing anyway. Deleting
/// a group already rewrites the order without it.
fn apply_sidebar_order(rec: &mut UserRoomGroupsRecord, order: Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    rec.order = order
        .into_iter()
        .filter(|id| !id.is_empty() && seen.insert(id.clone()))
        .collect();

    // Groups follow the list; any the list does not name keep the order they
    // had, after the ones it does.
    let rank = |group_id: &str| {
        rec.order
            .iter()
            .position(|id| id == group_id)
            .map(|at| at as i32)
    };
    let mut ranked: Vec<(Option<i32>, i32, String)> = rec
        .groups
        .iter()
        .map(|g| (rank(&g.group_id), g.position, g.group_id.clone()))
        .collect();
    ranked.sort_by(|a, b| match (a.0, b.0) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1),
    });
    for (position, (_, _, group_id)) in ranked.iter().enumerate() {
        if let Some(group) = rec.groups.iter_mut().find(|g| &g.group_id == group_id) {
            group.position = position as i32;
        }
    }
}

/// PUT /api/room-groups/order
pub(crate) async fn set_sidebar_order(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SetSidebarOrderRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    apply_sidebar_order(&mut rec, body.order);
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

/// PUT /api/room-groups/{group_id}/collapsed
pub(crate) async fn set_group_collapsed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(group_id): Path<String>,
    Json(body): Json<SetGroupCollapsedRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let mut rec = load_groups(&state, &user_id).await;
    let group = rec
        .groups
        .iter_mut()
        .find(|g| g.group_id == group_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Group not found"))?;
    group.collapsed = body.collapsed;
    save_groups(&state, &rec).await?;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(groups: &[(&str, i32)], order: &[&str]) -> UserRoomGroupsRecord {
        UserRoomGroupsRecord {
            user_id: "u_1".to_string(),
            groups: groups
                .iter()
                .map(|(id, position)| RoomGroupEntry {
                    group_id: (*id).to_string(),
                    name: (*id).to_string(),
                    position: *position,
                    collapsed: false,
                    room_ids: Vec::new(),
                })
                .collect(),
            order: order.iter().map(|id| (*id).to_string()).collect(),
        }
    }

    fn positions(rec: &UserRoomGroupsRecord) -> Vec<(String, i32)> {
        let mut out: Vec<(String, i32)> = rec
            .groups
            .iter()
            .map(|g| (g.group_id.clone(), g.position))
            .collect();
        out.sort_by(|a, b| a.1.cmp(&b.1));
        out
    }

    #[test]
    fn an_order_is_stored_as_the_client_sent_it() {
        let mut rec = record(&[], &[]);
        apply_sidebar_order(&mut rec, vec!["r_b".into(), "g_1".into(), "r_a".into()]);
        assert_eq!(rec.order, vec!["r_b", "g_1", "r_a"]);
    }

    #[test]
    fn an_id_sent_twice_is_kept_once_where_it_first_appeared() {
        // A drag that crosses itself can name the same room twice, and a room
        // in the list twice is a room drawn in two places.
        let mut rec = record(&[], &[]);
        apply_sidebar_order(&mut rec, vec!["r_a".into(), "r_b".into(), "r_a".into()]);
        assert_eq!(rec.order, vec!["r_a", "r_b"]);
    }

    #[test]
    fn empty_ids_are_dropped() {
        let mut rec = record(&[], &[]);
        apply_sidebar_order(&mut rec, vec!["".into(), "r_a".into()]);
        assert_eq!(rec.order, vec!["r_a"]);
    }

    #[test]
    fn groups_are_renumbered_to_match_the_order() {
        // `position` predates the list, and anything still reading it has to
        // see the arrangement the list describes.
        let mut rec = record(&[("g_1", 0), ("g_2", 1), ("g_3", 2)], &[]);
        apply_sidebar_order(
            &mut rec,
            vec!["g_3".into(), "r_a".into(), "g_1".into(), "g_2".into()],
        );
        assert_eq!(
            positions(&rec),
            vec![
                ("g_3".to_string(), 0),
                ("g_1".to_string(), 1),
                ("g_2".to_string(), 2)
            ]
        );
    }

    #[test]
    fn a_group_the_order_does_not_name_keeps_its_place_after_the_ones_it_does() {
        // The client sends what it was showing. A folder it had not heard of
        // yet must not be shuffled to the front by its absence.
        let mut rec = record(&[("g_1", 0), ("g_2", 1)], &[]);
        apply_sidebar_order(&mut rec, vec!["g_2".into()]);
        assert_eq!(
            positions(&rec),
            vec![("g_2".to_string(), 0), ("g_1".to_string(), 1)]
        );
    }

    #[test]
    fn an_empty_order_leaves_the_arrangement_the_groups_already_had() {
        let mut rec = record(&[("g_1", 0), ("g_2", 1)], &["g_1", "g_2"]);
        apply_sidebar_order(&mut rec, Vec::new());
        assert!(rec.order.is_empty());
        assert_eq!(
            positions(&rec),
            vec![("g_1".to_string(), 0), ("g_2".to_string(), 1)]
        );
    }
}
