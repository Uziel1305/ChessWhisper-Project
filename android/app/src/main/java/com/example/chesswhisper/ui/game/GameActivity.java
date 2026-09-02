package com.example.chesswhisper.ui.game;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;

import com.example.chesswhisper.R;
import com.example.chesswhisper.ui.home.HomeActivity;

import java.util.List;

// Bare host for BoardView. Not reachable from Home yet — Home's playButton and the
// real navigation into this screen are CW-41. Until then this exists so BoardView
// (hardcoded starting position) can be checked manually:
// adb shell am start -n com.example.chesswhisper/.ui.game.GameActivity
public class GameActivity extends AppCompatActivity {

    private static final String TAG = "GameActivity";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_game);

        BoardView boardView = findViewById(R.id.boardView);
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
