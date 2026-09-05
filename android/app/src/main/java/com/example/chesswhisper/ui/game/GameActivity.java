package com.example.chesswhisper.ui.game;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.game.model.MatchFound;
import com.example.chesswhisper.ui.home.HomeActivity;

import java.util.List;

// Hosts BoardView. Reached from Home's playButton on match.found (CW-41) — but also
// still launchable directly (adb) with no MatchFound extra for a bare manual check,
// in which case BoardView keeps its own hardcoded starting position.
public class GameActivity extends AppCompatActivity {

    public static final String EXTRA_MATCH_FOUND = "match_found";

    private static final String TAG = "GameActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_game);

        BoardView boardView = findViewById(R.id.boardView);

        MatchFound matchFound = (MatchFound) getIntent().getSerializableExtra(EXTRA_MATCH_FOUND);
        if (matchFound != null) {
            boardView.setPosition(matchFound.fen, matchFound.legalMoves);
        }

        boardView.setOnMoveListener(new BoardView.OnMoveListener() {
            @Override
            public void onMoveSelected(String uci) {
                // No WS client yet (CW-41) — logged so the manual check can confirm
                // the tap -> select -> highlight -> move flow, not a real send.
                Log.d(TAG, "move selected: " + uci);
            }

            @Override
            public void onPromotionNeeded(String from, String to, List<String> candidateUcis) {
                PromotionPickerDialog.show(GameActivity.this, candidateUcis,
                        uci -> Log.d(TAG, "move selected: " + uci));
            }
        });
    }

    private void goToHome() {
        startActivity(new Intent(this, HomeActivity.class));
        finish();
    }
}
