package com.example.chesswhisper.ui.home;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.RecyclerView;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.game.model.GameSummary;

import java.util.ArrayList;
import java.util.List;

// Renders the home screen's game history. Display only: every value on a row —
// including win/loss/draw — comes from the server as-is.
public class GameHistoryAdapter extends RecyclerView.Adapter<GameHistoryAdapter.ViewHolder> {

    private final List<GameSummary> games = new ArrayList<>();

    // The whole list is replaced on every load. At most a few dozen rows, so a
    // full rebind costs nothing and needs no DiffUtil.
    public void submit(List<GameSummary> newGames) {
        games.clear();
        games.addAll(newGames);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_game_history, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        GameSummary game = games.get(position);
        Context context = holder.itemView.getContext();

        holder.outcomeText.setText(outcomeLabel(game.getOutcome()));
        holder.outcomeText.setTextColor(ContextCompat.getColor(context, outcomeColor(game.getOutcome())));

        holder.opponentText.setText(context.getString(R.string.history_vs_opponent, game.getOpponent()));

        // A mode newer than this build shows its raw wire value rather than
        // nothing — the vocabulary grows (CLAUDE.md, the `mode` decision).
        GameMode mode = GameMode.fromWire(game.getMode());
        String modeLabel = mode != null ? context.getString(mode.labelRes) : game.getMode();
        int minutes = (int) (game.getTimeControlMs() / 60000);
        holder.modeText.setText(context.getString(R.string.history_mode_and_time, modeLabel, minutes));

        Integer delta = game.getRatingDelta();
        if (delta == null) {
            holder.ratingDeltaText.setVisibility(View.GONE);
        } else {
            holder.ratingDeltaText.setVisibility(View.VISIBLE);
            // Explicit sign always, same as GameResultDialog: "+0" reads as no
            // change, where a bare "0" could be misread.
            holder.ratingDeltaText.setText((delta >= 0 ? "+" : "") + delta);
        }
    }

    @Override
    public int getItemCount() {
        return games.size();
    }

    private static int outcomeLabel(String outcome) {
        if ("win".equals(outcome)) return R.string.history_outcome_win;
        if ("loss".equals(outcome)) return R.string.history_outcome_loss;
        return R.string.history_outcome_draw;
    }

    private static int outcomeColor(String outcome) {
        if ("win".equals(outcome)) return R.color.history_win;
        if ("loss".equals(outcome)) return R.color.history_loss;
        return R.color.history_draw;
    }

    static final class ViewHolder extends RecyclerView.ViewHolder {
        final TextView outcomeText;
        final TextView opponentText;
        final TextView modeText;
        final TextView ratingDeltaText;

        ViewHolder(View view) {
            super(view);
            outcomeText = view.findViewById(R.id.outcomeText);
            opponentText = view.findViewById(R.id.opponentText);
            modeText = view.findViewById(R.id.modeText);
            ratingDeltaText = view.findViewById(R.id.ratingDeltaText);
        }
    }
}
